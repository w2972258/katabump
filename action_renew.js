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
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// --- 深度破解验证码逻辑 ---
async function solveCaptchas(page) {
    console.log('  >> 正在扫描验证码...');
    const frames = page.frames();
    let solved = false;

    for (const frame of frames) {
        try {
            // 1. Cloudflare Turnstile 探测
            const cfSelector = 'iframe[src*="cloudflare"], #challenge-stage, .ctp-checkbox-label';
            const checkbox = frame.locator(cfSelector).first();
            
            if (await checkbox.isVisible({ timeout: 2000 })) {
                console.log('  >> 发现 Cloudflare 验证框，执行点击...');
                const box = await checkbox.boundingBox();
                if (box) {
                    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                    // 等待 Success 标志
                    for (let i = 0; i < 10; i++) {
                        const html = await frame.content();
                        if (html.includes('Success') || html.includes('verified')) {
                            console.log('  >> ✅ Cloudflare 验证成功');
                            solved = true; break;
                        }
                        await page.waitForTimeout(1000);
                    }
                }
            }

            // 2. ALTCHA 探测
            const altcha = page.locator('altcha-widget').first();
            if (await altcha.isVisible({ timeout: 1000 })) {
                console.log('  >> 发现 ALTCHA，执行破解...');
                const box = await altcha.boundingBox();
                if (box) {
                    await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.5);
                    for (let i = 0; i < 15; i++) {
                        if (await altcha.getAttribute('state') === 'verified') {
                            console.log('  >> ✅ ALTCHA 验证成功');
                            solved = true; break;
                        }
                        await page.waitForTimeout(1000);
                    }
                }
            }
        } catch (e) { }
        if (solved) break;
    }
    return solved;
}

// --- 启动 Chrome ---
async function launchChrome() {
    console.log('检查端口 ' + DEBUG_PORT);
    if (await checkPort(DEBUG_PORT)) return;

    console.log('启动 Chrome: ' + CHROME_PATH);
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--user-data-dir=/tmp/chrome_user_data', `--user-agent=${USER_AGENT}`
    ];
    
    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    chrome.unref();

    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) { console.log('Chrome 已就绪'); return; }
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('Chrome 启动超时');
}

function checkPort(port) {
    return new Promise(r => {
        http.get(`http://localhost:${port}/json/version`, () => r(true)).on('error', () => r(false)).end();
    });
}

// --- 主逻辑 ---
(async () => {
    console.log('--- 脚本开始运行 ---');
    
    // 检查环境变量
    let users = [];
    try {
        users = JSON.parse(process.env.USERS_JSON || '[]');
        console.log(`检测到用户数量: ${users.length}`);
    } catch (e) {
        console.error('USERS_JSON 解析失败，请检查 Secret 格式');
        process.exit(1);
    }

    if (users.length === 0) {
        console.error('错误: 用户列表为空，请检查环境变量 USERS_JSON');
        process.exit(1);
    }

    try {
        await launchChrome();
        const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
        const context = browser.contexts()[0];
        const page = context.pages()[0] || await context.newPage();
        page.setDefaultTimeout(30000);

        for (let user of users) {
            const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
            console.log(`\n>>> 正在处理: ${user.username}`);

            try {
                // 1. 登录
                await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'domcontentloaded' });
                await page.waitForSelector('input[name="email"]', { timeout: 15000 });
                
                await page.locator('input[name="email"]').fill(user.username);
                await page.locator('input[name="password"]').fill(user.password);
                
                // 处理可能存在的入口验证码
                await solveCaptchas(page);
                
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_before_login.png`) });
                await page.locator('button#submit').click();
                console.log('  已点击登录，等待跳转...');

                // 等待进入控制台
                await page.waitForURL('**/services', { timeout: 20000 }).catch(() => {});

                if (!page.url().includes('services')) {
                    console.log('  ❌ 登录失败，当前 URL:', page.url());
                    await page.screenshot({ path: path.join(photoDir, `${safeUser}_login_failed.png`) });
                    continue;
                }

                // 2. 续期
                await page.goto('https://dashboard.katabump.com/services');
                await page.getByRole('link', { name: 'See' }).first().click();
                
                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                await renewBtn.waitFor();
                
                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    await page.waitForSelector('#renew-modal');
                    
                    console.log('  处理模态框验证码...');
                    await page.waitForTimeout(2000);
                    await solveCaptchas(page);
                    
                    const finalShot = path.join(photoDir, `${safeUser}_renew_final.png`);
                    await page.screenshot({ path: finalShot });
                    
                    await page.locator('#renew-modal button#submit').click();
                    console.log('  ✅ 续期指令已发送');
                }
            } catch (err) {
                console.error(`  用户 ${user.username} 处理出错:`, err.message);
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_error.png`) }).catch(()=>{});
            }
        }
        await browser.close();
    } catch (globalErr) {
        console.error('全局运行错误:', globalErr.message);
    }
    
    console.log('--- 脚本运行结束 ---');
    process.exit(0);
})();
