const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
// 强制设置一个真实的 User-Agent
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// --- 通用验证码处理器 (支持 Cloudflare 和 ALTCHA) ---
async function solveCaptchas(page) {
    console.log('  >> 正在扫描页面验证码 (Cloudflare/ALTCHA)...');
    
    // 1. 检查是否有 Cloudflare 的验证 Frame
    const frames = page.frames();
    for (const frame of frames) {
        if (frame.url().includes('cloudflare') || frame.url().includes('turnstile')) {
            try {
                const checkbox = frame.locator('input[type="checkbox"]').first();
                if (await checkbox.isVisible({ timeout: 2000 })) {
                    console.log('  >> 发现 Cloudflare 验证，尝试点击...');
                    const box = await checkbox.boundingBox();
                    if (box) {
                        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                        await page.waitForTimeout(3000);
                        return true;
                    }
                }
            } catch (e) {}
        }
    }

    // 2. 检查是否有 ALTCHA 组件
    try {
        const altcha = page.locator('altcha-widget').first();
        if (await altcha.isVisible({ timeout: 2000 })) {
            const state = await altcha.getAttribute('state');
            if (state === 'verified') return true;

            console.log('  >> 发现 ALTCHA，执行模拟点击...');
            const box = await altcha.boundingBox();
            if (box) {
                // 点击 ALTCHA 的复选框区域（左侧）
                await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.5);
                
                // 等待计算完成
                for (let i = 0; i < 15; i++) {
                    const s = await altcha.getAttribute('state');
                    if (s === 'verified') {
                        console.log('  >> ALTCHA 验证通过！');
                        return true;
                    }
                    await page.waitForTimeout(1000);
                }
            }
        }
    } catch (e) {}

    return false;
}

async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) return;
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-sandbox',
        '--disable-gpu',
        '--user-data-dir=/tmp/chrome_user_data',
        `--user-agent=${USER_AGENT}` // 注入固定 UA
    ];
    if (process.env.HTTP_PROXY) {
        const p = new URL(process.env.HTTP_PROXY);
        args.push(`--proxy-server=${p.protocol}//${p.hostname}:${p.port}`);
    }
    spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 20; i++) { if (await checkPort(DEBUG_PORT)) break; await new Promise(r => setTimeout(r, 1000)); }
}

function checkPort(port) {
    return new Promise(r => {
        http.get(`http://localhost:${port}/json/version`, () => r(true)).on('error', () => r(false)).end();
    });
}

(async () => {
    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    const users = JSON.parse(process.env.USERS_JSON || '[]');
    await launchChrome();
    const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    const context = browser.contexts()[0];
    
    // 设置 context 级别的 UA
    await context.setExtraHTTPHeaders({ 'User-Agent': USER_AGENT });
    let page = context.pages()[0] || await context.newPage();

    for (let user of users) {
        console.log(`\n=== 处理用户: ${user.username} ===`);
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');

        try {
            // 步骤 1: 尝试进入登录页 (增加重试机制)
            let loginLoaded = false;
            for (let retry = 0; retry < 3; retry++) {
                console.log(`  >> 尝试访问登录页 (第 ${retry+1} 次)...`);
                await page.goto('https://dashboard.katabump.com/auth/login', { timeout: 60000 });
                
                // 检查是否被 Cloudflare 拦截
                await solveCaptchas(page);
                await page.waitForTimeout(5000);

                if (await page.locator('input[name="email"]').isVisible({ timeout: 5000 })) {
                    loginLoaded = true;
                    break;
                }
            }

            if (!loginLoaded) throw new Error('无法加载登录表单，可能被 Cloudflare 永久拦截');

            // 步骤 2: 填充并登录
            await page.locator('input[name="email"]').fill(user.username);
            await page.locator('input[name="password"]').fill(user.password);
            await solveCaptchas(page); // 再次处理表单内的 ALTCHA
            
            await page.locator('button#submit').click();
            console.log('  >> 已点击登录...');

            // 等待跳转
            await page.waitForURL('**/services', { timeout: 20000 }).catch(() => {});

            if (!page.url().includes('services')) {
                const shot = path.join(photoDir, `${safeUser}_fail.png`);
                await page.screenshot({ path: shot });
                console.log('  >> ❌ 登录跳转失败');
                continue;
            }

            // 步骤 3: 续期逻辑
            await page.goto('https://dashboard.katabump.com/services');
            const seeBtn = page.getByRole('link', { name: 'See' }).first();
            await seeBtn.waitFor();
            await seeBtn.click();

            const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
            await renewBtn.waitFor({ timeout: 10000 });
            
            if (await renewBtn.isVisible()) {
                await renewBtn.click();
                await page.waitForSelector('#renew-modal');
                await page.waitForTimeout(2000);
                await solveCaptchas(page); // 处理模态框验证码

                const finalShot = path.join(photoDir, `${safeUser}_renew.png`);
                await page.screenshot({ path: finalShot });
                await page.locator('#renew-modal button#submit').click();
                
                console.log('  >> ✅ 任务完成');
                // 发送 TG 通知...
            }
        } catch (err) {
            console.error('运行出错:', err.message);
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_error.png`) }).catch(()=>{});
        }
    }
    await browser.close();
    process.exit(0);
})();
