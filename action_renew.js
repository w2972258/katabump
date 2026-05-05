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
 * 强力验证码处理器：专门针对 ALTCHA 做了点击增强
 */
async function forceSolveCaptcha(page, stepName) {
    console.log(`  >> [${stepName}] 正在强制扫描拦截框...`);
    const startTime = Date.now();
    const timeout = 60000; // 增加到 60 秒

    while (Date.now() - startTime < timeout) {
        // --- 1. 处理 Cloudflare (使用 CDP 模拟点击) ---
        const frames = page.frames();
        for (const frame of frames) {
            try {
                const tokenReady = await frame.evaluate(() => {
                    const input = document.querySelector('[name*="turnstile-response"]');
                    return input && input.value.length > 20;
                }).catch(() => false);
                if (tokenReady) return true;

                const pos = await frame.evaluate(() => window.__captcha_pos).catch(() => null);
                if (pos) {
                    const fEl = await frame.frameElement();
                    const box = await fEl.boundingBox();
                    if (box) {
                        const client = await page.context().newCDPSession(page);
                        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x + pos.x, y: box.y + pos.y, button: 'left', clickCount: 1 });
                        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + pos.x, y: box.y + pos.y, button: 'left', clickCount: 1 });
                        await client.detach();
                        await page.waitForTimeout(4000);
                    }
                }
            } catch (e) {}
        }

        // --- 2. 处理 ALTCHA (针对第 5 张图的情况强化) ---
        const altcha = page.locator('altcha-widget').first();
        if (await altcha.isVisible({timeout: 1000}).catch(()=>false)) {
            const state = await altcha.getAttribute('state');
            if (state === 'verified') {
                console.log(`  >> [${stepName}] ✅ ALTCHA 已通过`);
                return true;
            }
            
            if (state !== 'computing') {
                console.log(`  >> [${stepName}] 发现未勾选的 ALTCHA，执行强力点击...`);
                // 尝试多种点击策略：1. 坐标点击 2. 穿透点击内部元素
                const box = await altcha.boundingBox();
                if (box) {
                    // 策略 A: 模拟鼠标点击复选框位置
                    await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.5);
                    // 策略 B: 尝试直接点击组件（有时组件本身有点击监听）
                    await altcha.click({ position: { x: 20, y: 25 }, force: true }).catch(()=>{});
                }
                await page.waitForTimeout(4000); // 给计算留时间
            } else {
                console.log(`  >> [${stepName}] ⏳ ALTCHA 正在计算 hash...`);
            }
        }

        await page.waitForTimeout(2000);
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
    console.log('--- 强力 ALTCHA 适配版启动 ---');
    const users = JSON.parse(process.env.USERS_JSON || '[]');
    await launchChrome();
    const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    const context = browser.contexts()[0];
    await context.addInitScript(INJECTED_SCRIPT);
    const page = context.pages()[0] || await context.newPage();

    for (let user of users) {
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        try {
            // 登录流程
            await page.goto('https://dashboard.katabump.com/auth/login');
            await forceSolveCaptcha(page, "登录页");
            await page.locator('input[name="email"]').fill(user.username);
            await page.locator('input[name="password"]').fill(user.password);
            await forceSolveCaptcha(page, "登录前二次确认");
            await page.locator('button#submit').click();

            // 进入后台
            await page.waitForURL(url => !url.href.includes('/auth/'), { timeout: 20000 });
            await page.goto('https://dashboard.katabump.com/dashboard');
            
            // 点击 See
            const seeBtn = page.locator('table a:has-text("See"), table a:has-text("Manage"), .btn-outline-primary').first();
            await seeBtn.waitFor({ state: 'visible' });
            await seeBtn.click();
            await page.waitForTimeout(3000);

            // 续期操作
            const renewBtnTrigger = page.locator('button[data-bs-target="#renew-modal"]');
            if (await renewBtnTrigger.isVisible()) {
                await renewBtnTrigger.click();
                // 确保模态框完全显示且动画结束
                await page.waitForSelector('#renew-modal.show', { timeout: 5000 });
                await page.waitForTimeout(2000); 
                
                // 【核心修复步聚】：强力解决模态框验证
                await forceSolveCaptcha(page, "模态框内部"); 
                
                // 此时截图，确认是否有绿色的勾
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_05_renew_checked.png`) });

                // 提交续期：确保点击的是 Renew 按钮而不是 Close
                console.log('  正在提交续期表单...');
                await page.locator('#renew-modal button[type="submit"]').click();
                
                await page.waitForTimeout(6000);
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_06_final_result.png`) });

                if (TG_BOT_TOKEN) {
                    exec(`curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${path.join(photoDir, `${safeUser}_06_final_result.png`)}" -F caption="🤖 ${user.username} 续期执行报告"`);
                }
            }
        } catch (err) {
            console.error(`  异常: ${err.message}`);
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_99_error.png`) }).catch(()=>{});
        }
    }
    await browser.close();
    process.exit(0);
})();
