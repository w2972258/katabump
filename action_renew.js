const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

// 强制创建截图目录
const photoDir = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
// 使用稳定的桌面端 User-Agent
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * 核心：验证码处理器 (支持死等 Success 状态)
 */
async function solveCaptchas(page) {
    console.log('  >> 正在监控验证码状态 (Cloudflare/ALTCHA)...');
    const startTime = Date.now();
    const timeout = 30000; // 最多等待 30 秒

    while (Date.now() - startTime < timeout) {
        const frames = page.frames();
        for (const frame of frames) {
            try {
                // 1. 处理 Cloudflare Turnstile
                if (frame.url().includes('cloudflare.com/cdn-cgi/challenge')) {
                    const content = await frame.content();
                    
                    // 检查是否已经验证成功
                    if (content.includes('Success') || content.includes('verified')) {
                        console.log('  >> ✅ Cloudflare 验证成功！');
                        return true;
                    }

                    // 检查是否正在验证中
                    if (content.includes('Verifying')) {
                        // 已经在验证了，保持静默等待
                        continue;
                    }

                    // 如果还没点，尝试点击复选框
                    const checkbox = frame.locator('.ctp-checkbox-label, #challenge-stage').first();
                    if (await checkbox.isVisible()) {
                        console.log('  >> 发现未触发的复选框，执行模拟点击...');
                        const box = await checkbox.boundingBox();
                        if (box) {
                            // 点击位置稍微偏左，模拟人类点击习惯
                            await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.5);
                            await page.waitForTimeout(2000);
                        }
                    }
                }
            } catch (e) { }
        }

        // 2. 处理 ALTCHA
        try {
            const altcha = page.locator('altcha-widget').first();
            if (await altcha.isVisible({ timeout: 500 })) {
                const state = await altcha.getAttribute('state');
                if (state === 'verified') {
                    console.log('  >> ✅ ALTCHA 验证成功！');
                    return true;
                }
                if (state !== 'computing') {
                    const box = await altcha.boundingBox();
                    if (box) {
                        await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.5);
                    }
                }
            }
        } catch (e) { }

        await page.waitForTimeout(1000); // 每秒轮询一次
    }

    console.log('  >> ⚠️ 验证码处理超时');
    return false;
}

async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) return;
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--user-data-dir=/tmp/chrome_user_data', `--user-agent=${USER_AGENT}`
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
    console.log('--- 自动化续期脚本启动 ---');
    const users = JSON.parse(process.env.USERS_JSON || '[]');
    await launchChrome();
    
    const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();

    for (let user of users) {
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n>>> 正在处理用户: ${user.username}`);

        try {
            // 1. 登录流程
            await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('input[name="email"]', { timeout: 15000 });
            
            await page.locator('input[name="email"]').fill(user.username);
            await page.locator('input[name="password"]').fill(user.password);
            
            // 核心修复点：死等验证码成功
            await solveCaptchas(page);
            
            // 验证通过后额外等待，确保 Token 填入
            await page.waitForTimeout(2000); 
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_ready_to_login.png`) });

            // 精准点击登录按钮 (避免 ID 冲突)
            await page.locator('button#submit').click();
            console.log('  已点击登录，等待页面跳转...');

            await page.waitForURL(url => url.includes('services') || url.includes('dashboard'), { timeout: 20000 }).catch(() => {});

            if (!page.url().includes('services') && !page.url().includes('dashboard')) {
                console.log('  ❌ 登录失败，当前 URL:', page.url());
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_login_failed.png`) });
                continue;
            }

            // 2. 续期流程
            await page.goto('https://dashboard.katabump.com/services', { waitUntil: 'domcontentloaded' });
            const seeBtn = page.getByRole('link', { name: 'See' }).first();
            await seeBtn.waitFor();
            await seeBtn.click();

            const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
            await renewBtn.waitFor({ timeout: 10000 });

            if (await renewBtn.isVisible()) {
                await renewBtn.click();
                await page.waitForSelector('#renew-modal');
                
                console.log('  处理模态框中的验证码...');
                await page.waitForTimeout(2000);
                await solveCaptchas(page);
                
                const finalShot = path.join(photoDir, `${safeUser}_renew_final.png`);
                await page.screenshot({ path: finalShot });
                
                await page.locator('#renew-modal button#submit').click();
                console.log('  ✅ 续期指令已发送');
                await page.waitForTimeout(3000);
            } else {
                console.log('  ℹ️ 未找到续期按钮，可能已续期');
            }
        } catch (err) {
            console.error(`  处理出错: ${err.message}`);
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_error.png`) }).catch(()=>{});
        }
    }

    await browser.close();
    console.log('--- 脚本运行结束 ---');
    process.exit(0);
})();
