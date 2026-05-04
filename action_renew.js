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

// --- 模拟人类点击 ---
async function humanLikeClick(page, element) {
    const box = await element.boundingBox();
    if (!box) return;
    const targetX = box.x + box.width * 0.15 + (Math.random() * 5);
    const targetY = box.y + box.height * 0.5 + (Math.random() * 5);

    await page.mouse.move(targetX - 50, targetY - 50);
    await page.mouse.move(targetX, targetY, { steps: 10 });
    await page.waitForTimeout(100 + Math.random() * 200);
    await page.mouse.click(targetX, targetY);
}

// --- ALTCHA 绕过逻辑 ---
async function solveAltcha(page) {
    console.log('  >> 正在定位 ALTCHA 验证码...');
    const frames = [page, ...page.frames()];
    for (const frame of frames) {
        try {
            const altcha = frame.locator('altcha-widget').first();
            if (await altcha.isVisible({ timeout: 5000 })) {
                const state = await altcha.getAttribute('state');
                if (state === 'verified') return true;

                console.log('  >> 发现 ALTCHA，执行模拟点击...');
                await humanLikeClick(page, altcha);

                for (let i = 0; i < 20; i++) {
                    const currentState = await altcha.getAttribute('state');
                    if (currentState === 'verified') {
                        console.log('  >> ALTCHA 验证通过！');
                        return true;
                    }
                    await page.waitForTimeout(1000);
                }
            }
        } catch (e) { }
    }
    return false;
}

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            chat_id: TG_CHAT_ID, text: message, parse_mode: 'Markdown'
        });
    } catch (e) { }
    if (imagePath && fs.existsSync(imagePath)) {
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        exec(cmd);
    }
}

async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) return;
    const args = [`--remote-debugging-port=${DEBUG_PORT}`, '--no-sandbox', '--disable-gpu', '--user-data-dir=/tmp/chrome_user_data'];
    if (PROXY_CONFIG) args.push(`--proxy-server=${PROXY_CONFIG.server}`);
    spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 20; i++) { if (await checkPort(DEBUG_PORT)) break; await new Promise(r => setTimeout(r, 1000)); }
}

function checkPort(port) {
    return new Promise(r => {
        http.get(`http://localhost:${port}/json/version`, () => r(true)).on('error', () => r(false)).end();
    });
}

(async () => {
    // 提前创建截图目录，防止 artifact 上传失败
    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    const users = JSON.parse(process.env.USERS_JSON || '[]');
    await launchChrome();
    const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    const context = browser.contexts()[0];
    let page = context.pages()[0] || await context.newPage();
    
    if (PROXY_CONFIG?.username) {
        await context.setHTTPCredentials({ username: PROXY_CONFIG.username, password: PROXY_CONFIG.password });
    }

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 处理用户: ${user.username} ===`);

        try {
            await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'networkidle' });
            
            // 登录表单填充
            await page.locator('input[name="email"]').fill(user.username);
            await page.locator('input[name="password"]').fill(user.password);
            
            // 处理验证码
            await solveAltcha(page);

            // 【修复关键点】使用更精准的选择器，避免多个 Login 按钮冲突
            const loginBtn = page.locator('button#submit'); // 直接通过 ID 锁定
            await loginBtn.click();

            await page.waitForTimeout(3000);

            // 检查是否登录成功
            if (page.url().includes('login')) {
                const error = await page.getByText('Incorrect password').isVisible();
                if (error) {
                    console.log('  >> ❌ 密码错误');
                    await page.screenshot({ path: path.join(photoDir, `${safeUser}_login_fail.png`) });
                    continue;
                }
            }

            // 进入续期流程
            await page.goto('https://dashboard.katabump.com/services', { waitUntil: 'networkidle' });
            const seeBtn = page.getByRole('link', { name: 'See' }).first();
            if (await seeBtn.isVisible()) {
                await seeBtn.click();
                await page.waitForTimeout(2000);

                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    await page.waitForSelector('#renew-modal', { state: 'visible' });

                    await solveAltcha(page);
                    
                    const finalShot = path.join(photoDir, `${safeUser}_renew_page.png`);
                    await page.screenshot({ path: finalShot });

                    // 点击模态框内的确认按钮
                    await page.locator('#renew-modal button#submit, #renew-modal .btn-primary').first().click();
                    
                    await page.waitForTimeout(3000);
                    console.log(`  >> 任务尝试完成，请检查 TG 通知。`);
                    await sendTelegramMessage(`🤖 *续期任务执行完毕*\n用户: ${user.username}`, finalShot);
                }
            }
        } catch (err) {
            console.error('运行时出错:', err.message);
            // 出错时强制截图，方便调试
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_error.png`) }).catch(()=>{});
        }
    }

    await browser.close();
    process.exit(0);
})();
