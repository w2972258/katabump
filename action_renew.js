const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// 启用 stealth 插件
chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
process.env.NO_PROXY = 'localhost,127.0.0.1';

// --- 代理配置 ---
const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;
if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
    } catch (e) { console.error('[代理] 格式无效'); process.exit(1); }
}

// --- 核心：人类行为模拟函数 ---
async function humanLikeClick(page, element) {
    const box = await element.boundingBox();
    if (!box) return;

    // 目标点：复选框通常在左侧 (15% 宽度处)
    const targetX = box.x + box.width * 0.15 + (Math.random() * 5);
    const targetY = box.y + box.height * 0.5 + (Math.random() * 5);

    // 1. 模拟鼠标随机移动轨迹
    await page.mouse.move(
        targetX - 100 - Math.random() * 100, 
        targetY - 100 - Math.random() * 100
    );
    await page.mouse.move(targetX, targetY, { steps: 15 + Math.floor(Math.random() * 10) });

    // 2. 微小停顿后点击
    await page.waitForTimeout(200 + Math.random() * 300);
    await page.mouse.down();
    await page.waitForTimeout(50 + Math.random() * 100);
    await page.mouse.up();
}

// --- 核心：ALTCHA 绕过逻辑 ---
async function solveAltcha(page) {
    console.log('  >> 正在定位 ALTCHA 验证码...');
    
    // ALTCHA 可能在主页面也可能在 iframe
    const frames = [page, ...page.frames()];
    for (const frame of frames) {
        try {
            const altcha = await frame.locator('altcha-widget').first();
            if (await altcha.isVisible()) {
                // 检查是否已验证
                const state = await altcha.getAttribute('state');
                if (state === 'verified') return true;

                console.log('  >> 发现未验证的 ALTCHA，执行人类化点击...');
                await humanLikeClick(page, altcha); // 注意：使用 page 级别鼠标点击绝对坐标

                // 等待 PoW 计算完成 (通常 2-8 秒)
                for (let i = 0; i < 15; i++) {
                    const currentState = await altcha.getAttribute('state');
                    if (currentState === 'verified') {
                        console.log('  >> ALTCHA 验证成功！');
                        return true;
                    }
                    await page.waitForTimeout(1000);
                }
            }
        } catch (e) { /* 忽略单个 frame 的错误 */ }
    }
    return false;
}

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            chat_id: TG_CHAT_ID, text: message, parse_mode: 'Markdown'
        });
    } catch (e) { console.error('[TG] 发送文字失败'); }

    if (imagePath && fs.existsSync(imagePath)) {
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        exec(cmd);
    }
}

async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) return;
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-sandbox', '--disable-gpu', '--window-size=1280,720',
        '--user-data-dir=/tmp/chrome_user_data', '--disable-dev-shm-usage'
    ];
    if (PROXY_CONFIG) args.push(`--proxy-server=${PROXY_CONFIG.server}`);
    spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 20; i++) { if (await checkPort(DEBUG_PORT)) break; await new Promise(r => setTimeout(r, 1000)); }
}

function checkPort(port) {
    return new Promise(r => {
        http.get(`http://localhost:${port}/json/version`, () => r(true)).on('error', () => r(false)).end();
    });
}

// --- 主程序 ---
(async () => {
    const users = JSON.parse(process.env.USERS_JSON || '[]');
    await launchChrome();
    const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    const context = browser.contexts()[0];
    let page = context.pages()[0] || await context.newPage();
    
    if (PROXY_CONFIG?.username) {
        await context.setHTTPCredentials({ username: PROXY_CONFIG.username, password: PROXY_CONFIG.password });
    }

    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 用户 ${i + 1}/${users.length}: ${user.username} ===`);

        try {
            // 1. 登录流程
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(2000);

            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.goto('https://dashboard.katabump.com/auth/login');
            }

            await page.getByRole('textbox', { name: 'Email' }).fill(user.username);
            await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
            
            // 登录页验证码
            await solveAltcha(page);
            await page.getByRole('button', { name: 'Login' }).click();

            // 检查登录失败
            if (await page.getByText('Incorrect password').isVisible({ timeout: 3000 })) {
                await sendTelegramMessage(`❌ *登录失败*: ${user.username}`);
                continue;
            }

            // 2. 进入续期页
            await page.getByRole('link', { name: 'See' }).first().click();
            await page.waitForTimeout(2000);

            // 3. 续期大循环 (最多尝试 5 次)
            let success = false;
            for (let attempt = 1; attempt <= 5; attempt++) {
                console.log(`  [续期尝试 ${attempt}/5]`);
                const renewBtn = page.getByRole('button', { name: 'Renew' }).first();
                
                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    await page.waitForSelector('#renew-modal', { state: 'visible' });

                    // 处理模态框中的验证码
                    await page.waitForTimeout(1000);
                    const solved = await solveAltcha(page);
                    
                    // 截图保存
                    const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
                    const shotPath = path.join(photoDir, `${safeUser}_altcha.png`);
                    await page.screenshot({ path: shotPath });

                    // 点击模态框内的续期按钮
                    await page.locator('#renew-modal').getByRole('button', { name: 'Renew' }).click();
                    
                    await page.waitForTimeout(2000);
                    if (await page.getByText("You can't renew your server yet").isVisible()) {
                        console.log('  >> 还没到续期时间。');
                        success = true; break;
                    }

                    if (!await page.locator('#renew-modal').isVisible()) {
                        console.log('  >> ✅ 续期成功！');
                        await sendTelegramMessage(`✅ *续期成功*: ${user.username}`, shotPath);
                        success = true; break;
                    }
                    
                    console.log('  >> 验证可能失败，刷新重试...');
                    await page.reload();
                    await page.waitForTimeout(2000);
                } else {
                    console.log('  >> 未找到 Renew 按钮，可能已续期。');
                    success = true; break;
                }
            }
        } catch (err) {
            console.error('处理用户出错:', err.message);
        }
    }

    await browser.close();
    process.exit(0);
})();
