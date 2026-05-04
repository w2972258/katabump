const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

// 1. 基础环境准备
const photoDir = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * 核心逻辑：验证码破解器 (不看颜色，只看逻辑)
 * 判定标准：Token 已生成 或 Success 文本已显示
 */
async function solveCaptchas(page) {
    console.log('  >> 正在扫描验证码底层状态 (寻找 Token 或 成功标志)...');
    const startTime = Date.now();
    const timeout = 35000; // 在 GitHub Actions 中建议给足 35 秒

    while (Date.now() - startTime < timeout) {
        const frames = page.frames();
        for (const frame of frames) {
            try {
                // --- 1. 处理 Cloudflare Turnstile ---
                if (frame.url().includes('cloudflare.com/cdn-cgi/challenge')) {
                    
                    // 【硬核逻辑 A】：检查 Token 是否已注入 (最准确的方法)
                    const tokenReady = await frame.evaluate(() => {
                        const responseInput = document.querySelector('[name*="turnstile-response"]');
                        // 只要这个 input 框有了较长的字符串，就说明后端已经验证通过并下发了 Token
                        return responseInput && responseInput.value.length > 15;
                    }).catch(() => false);

                    if (tokenReady) {
                        console.log('  >> ✅ 逻辑确认：验证码加密 Token 已注入！');
                        return true;
                    }

                    // 【硬核逻辑 B】：检查“成功”文本是否存在 (视觉兜底)
                    const isSuccessText = await frame.locator('#success-text').isVisible().catch(() => false);
                    if (isSuccessText) {
                        console.log('  >> ✅ 视觉确认：Success 状态已显示！');
                        return true;
                    }

                    // 如果以上都没满足，检查是否需要点击
                    const checkbox = frame.locator('#challenge-stage, .ctp-checkbox-label').first();
                    if (await checkbox.isVisible()) {
                        // 检查是否正在验证中 (圈圈在转)，防止重复点击导致重置
                        const isVerifying = await frame.locator('#verifying-text, .ctp-loader').first().isVisible().catch(() => false);
                        if (!isVerifying) {
                            console.log('  >> 发现未触发复选框，执行模拟点击...');
                            const box = await checkbox.boundingBox();
                            if (box) {
                                // 点击偏左一点，增加人类行为真实感
                                await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.5);
                                await page.waitForTimeout(2000); // 点击后给 2 秒观察
                            }
                        }
                    }
                }
            } catch (e) { }
        }

        // --- 2. 处理 ALTCHA ---
        try {
            const altcha = page.locator('altcha-widget').first();
            if (await altcha.isVisible({ timeout: 200 })) {
                if (await altcha.getAttribute('state') === 'verified') {
                    console.log('  >> ✅ ALTCHA 验证通过！');
                    return true;
                }
                const box = await altcha.boundingBox();
                if (box) await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.5);
            }
        } catch (e) { }

        await page.waitForTimeout(1000); // 轮询频率
    }
    console.log('  >> ⚠️ 验证码扫描超时');
    return false;
}

/**
 * 启动 Chrome 调试实例
 */
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

/**
 * Telegram 通知辅助
 */
async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            chat_id: TG_CHAT_ID, text: message, parse_mode: 'Markdown'
        });
        if (imagePath && fs.existsSync(imagePath)) {
            const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
            exec(cmd);
        }
    } catch (e) { console.error('[TG] 发送失败'); }
}

/**
 * 主程序
 */
(async () => {
    console.log('--- Katabump 自动化续期启动 ---');
    
    let users = [];
    try {
        users = JSON.parse(process.env.USERS_JSON || '[]');
        console.log(`载入用户数量: ${users.length}`);
    } catch (e) { console.error('USERS_JSON 解析错误'); process.exit(1); }

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
            
            // 关键：破解验证码并死等成功
            await solveCaptchas(page);
            
            // 验证后的缓冲（非常重要，给表单注入 Token 的时间）
            await page.waitForTimeout(2000); 
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_final_ready.png`) });

            console.log('  提交登录表单...');
            await page.locator('button#submit').click();

            // 等待跳转，验证是否真的进去了
            try {
                await page.waitForURL(url => url.href.includes('services') || url.href.includes('dashboard'), { timeout: 20000 });
                console.log('  ✅ 登录成功！');
            } catch (e) {
                console.log('  ❌ 登录跳转失败，检查截图：', `${safeUser}_login_fail.png`);
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_login_fail.png`) });
                continue;
            }

            // 2. 续期流程
            await page.goto('https://dashboard.katabump.com/services');
            const seeBtn = page.getByRole('link', { name: 'See' }).first();
            await seeBtn.waitFor();
            await seeBtn.click();

            const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
            await renewBtn.waitFor({ timeout: 10000 });

            if (await renewBtn.isVisible()) {
                await renewBtn.click();
                await page.waitForSelector('#renew-modal');
                
                console.log('  处理续期模态框验证码...');
                await page.waitForTimeout(2000);
                await solveCaptchas(page);
                
                const finalShot = path.join(photoDir, `${safeUser}_renew_submit.png`);
                await page.screenshot({ path: finalShot });
                
                await page.locator('#renew-modal button#submit').click();
                console.log('  ✅ 续期请求已提交');
                
                await page.waitForTimeout(3000);
                await sendTelegramMessage(`✅ *续期成功*\n用户: ${user.username}`, finalShot);
            } else {
                console.log('  ℹ️ 暂不需要续期');
            }
        } catch (err) {
            console.error(`  发生错误: ${err.message}`);
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_error.png`) }).catch(()=>{});
        }
    }

    await browser.close();
    console.log('--- 任务全部结束 ---');
    process.exit(0);
})();
