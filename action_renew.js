const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const photoDir = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

// 注入脚本：捕获影子 DOM 内的坐标 (针对 Cloudflare)
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const observer = new MutationObserver(() => {
                    const cb = shadowRoot.querySelector('input[type="checkbox"], #challenge-stage, .ctp-checkbox-label');
                    if (cb) {
                        const rect = cb.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            window.__captcha_pos = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                        }
                    }
                });
                observer.observe(shadowRoot, { childList: true, subtree: true });
            }
            return shadowRoot;
        };
    } catch (e) {}
})();
`;

/**
 * 验证码全能破解器：适配 Cloudflare 和源码中的 ALTCHA
 */
async function solveCaptchas(page, stepName) {
    console.log(`  >> [${stepName}] 扫描验证码...`);
    const startTime = Date.now();
    while (Date.now() - startTime < 35000) {
        const frames = page.frames();
        for (const frame of frames) {
            try {
                // 1. 检查 Cloudflare Token
                const tokenReady = await frame.evaluate(() => {
                    const input = document.querySelector('[name*="turnstile-response"]');
                    return input && input.value.length > 20;
                }).catch(() => false);
                if (tokenReady) return true;

                // 2. 检查并点击 Cloudflare (CDP 模拟)
                const pos = await frame.evaluate(() => window.__captcha_pos).catch(() => null);
                if (pos) {
                    const fEl = await frame.frameElement();
                    const box = await fEl.boundingBox();
                    if (box) {
                        const client = await page.context().newCDPSession(page);
                        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x + pos.x, y: box.y + pos.y, button: 'left', clickCount: 1 });
                        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + pos.x, y: box.y + pos.y, button: 'left', clickCount: 1 });
                        await client.detach();
                        await page.waitForTimeout(3000);
                    }
                }
            } catch (e) {}
        }
        // 3. 检查 ALTCHA (源码中续期用的就是这个)
        const altcha = page.locator('altcha-widget').first();
        if (await altcha.isVisible({timeout: 100}).catch(()=>false)) {
            if (await altcha.getAttribute('state') === 'verified') return true;
            const box = await altcha.boundingBox();
            if (box) await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.5);
        }
        await page.waitForTimeout(1000);
    }
    return false;
}

async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) return;
    const args = [`--remote-debugging-port=${DEBUG_PORT}`, '--no-sandbox', '--disable-gpu', '--window-size=1280,720', '--user-data-dir=/tmp/chrome_user_data'];
    spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 20; i++) { if (await checkPort(DEBUG_PORT)) break; await new Promise(r => setTimeout(r, 1000)); }
}

function checkPort(port) { return new Promise(r => { http.get(`http://localhost:${port}/json/version`, () => r(true)).on('error', () => r(false)).end(); }); }

(async () => {
    console.log('--- 融合原版优势的全流程监控版启动 ---');
    const users = JSON.parse(process.env.USERS_JSON || '[]');
    await launchChrome();
    const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    const context = browser.contexts()[0];
    await context.addInitScript(INJECTED_SCRIPT);
    const page = context.pages()[0] || await context.newPage();

    for (let user of users) {
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n>>> 用户: ${user.username}`);

        try {
            // 步骤 1：登录
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_01_login_page.png`) });
            await page.locator('input[name="email"]').fill(user.username);
            await page.locator('input[name="password"]').fill(user.password);
            
            await solveCaptchas(page, "登录验证");
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_02_login_ready.png`) });

            await page.locator('button#submit').click();
            await page.waitForTimeout(5000);

            // 步骤 2：检查跳转
            await page.waitForURL(url => !url.href.includes('/auth/'), { timeout: 15000 });
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_03_dashboard.png`) });
            console.log('  ✅ 登录成功，正在寻找服务器链接...');

            // 步骤 3：点击进入服务器详情
            // 兼容性选择器：优先找 See，找不到就找表格里的第一个链接
            const serverLink = page.locator('table a:has-text("See"), table a:has-text("Manage"), .btn-outline-primary').first();
            await serverLink.waitFor({ state: 'visible', timeout: 10000 });
            await serverLink.click();
            
            await page.waitForTimeout(3000);
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_04_server_detail.png`) });

            // 步骤 4：根据源码点击 Renew 触发模态框
            const renewTrigger = page.locator('button[data-bs-target="#renew-modal"]');
            if (await renewTrigger.isVisible()) {
                await renewTrigger.click();
                await page.waitForSelector('#renew-modal.show', { timeout: 5000 });
                console.log('  已打开续期模态框');
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_05_renew_modal.png`) });

                // 步骤 5：处理模态框内的 ALTCHA 验证
                await solveCaptchas(page, "续期确认");
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_06_renew_ready.png`) });

                // 步骤 6：提交续期 (源码显示提交按钮在 footer 且是 btn-primary)
                await page.locator('#renew-modal button[type="submit"]').click();
                console.log('  ✅ 续期指令已提交');
                
                await page.waitForTimeout(5000);
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_07_final_result.png`) });
            } else {
                console.log('  ℹ️ 状态: 当前无法续期 (未找到按钮)');
            }
        } catch (err) {
            console.error(`  异常: ${err.message}`);
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_99_error.png`) }).catch(()=>{});
        }
    }
    await browser.close();
    process.exit(0);
})();
