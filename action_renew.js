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
 * 核心：拦截框强力处理器 (针对 ALTCHA 深度优化)
 */
async function solveAnyInterceptor(page, safeUser, stepId, stepName) {
    console.log(`  >> [${stepId}] 拦截检查: ${stepName}...`);
    const startTime = Date.now();
    const timeout = 60000; // 每个关键点最多等 60s
    let hasEverSeenCaptcha = false;

    while (Date.now() - startTime < timeout) {
        let currentCaptchaFound = false;

        // --- 1. Cloudflare 检测 ---
        const frames = page.frames();
        for (const frame of frames) {
            const token = await frame.evaluate(() => {
                const input = document.querySelector('[name*="turnstile-response"]');
                return input && input.value.length > 20;
            }).catch(() => false);

            if (token) {
                console.log(`  >> [${stepId}] Cloudflare 逻辑通过`);
                return true;
            }

            const pos = await frame.evaluate(() => window.__captcha_pos).catch(() => null);
            if (pos) {
                currentCaptchaFound = true;
                hasEverSeenCaptcha = true;
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
        }

        // --- 2. ALTCHA 检测 (恢复双重点击策略) ---
        const altcha = page.locator('altcha-widget').first();
        if (await altcha.isVisible({timeout: 1000}).catch(()=>false)) {
            currentCaptchaFound = true;
            hasEverSeenCaptcha = true;
            const state = await altcha.getAttribute('state');
            if (state === 'verified') {
                console.log(`  >> [${stepId}] ✅ ALTCHA 验证成功`);
                return true;
            }
            if (state !== 'computing') {
                console.log(`  >> [${stepId}] 触发 ALTCHA 点击...`);
                const box = await altcha.boundingBox();
                if (box) {
                    // 策略 A: 模拟鼠标底层点击
                    await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.5);
                    // 策略 B: 穿透组件点击 (恢复之前的成功方案)
                    await altcha.click({ position: { x: 20, y: 25 }, force: true }).catch(()=>{});
                }
                await page.waitForTimeout(4000);
            }
        }

        // 退出逻辑优化：只有在至少稳定观察了 5 秒且从未发现验证码的情况下才放行
        if (!currentCaptchaFound && !hasEverSeenCaptcha && Date.now() - startTime > 5000) {
            console.log(`  >> [${stepId}] 确认环境干净，放行`);
            return true;
        }

        await page.waitForTimeout(2000);
    }
    console.log(`  >> [${stepId}] ⚠️ 验证处理超时`);
    return false;
}

(async () => {
    const users = JSON.parse(process.env.USERS_JSON || '[]');
    await launchChrome();
    const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    const context = browser.contexts()[0];
    await context.addInitScript(INJECTED_SCRIPT);
    const page = context.pages()[0] || await context.newPage();

    for (let user of users) {
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n>>> 处理用户: ${user.username}`);

        try {
            // 01. 登录页加载
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_01_login_load.png`) });
            
            // 02. 登录拦截处理中
            await solveAnyInterceptor(page, safeUser, "02", "登录页拦截扫描");
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_02_login_captcha_solving.png`) });

            // 03. 填充凭据
            await page.locator('input[name="email"]').fill(user.username);
            await page.locator('input[name="password"]').fill(user.password);
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_03_creds_filled.png`) });

            // 04. 登录就绪 (确认打勾)
            await solveAnyInterceptor(page, safeUser, "04", "提交登录前终检");
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_04_login_ready.png`) });

            await page.locator('button#submit').click();
            await page.waitForTimeout(4000);
            
            // 05. 登录跳转结果
            await page.waitForURL(url => !url.href.includes('/auth/'), { timeout: 20000 });
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_05_dashboard_home.png`) });

            // 06. 进入服务器页
            await page.goto('https://dashboard.katabump.com/dashboard');
            const seeBtn = page.locator('table a:has-text("See"), .btn-outline-primary').first();
            await seeBtn.click();
            await page.waitForTimeout(3000);
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_06_server_detail.png`) });

            // 07. 模态框打开瞬间
            const renewTrigger = page.locator('button[data-bs-target="#renew-modal"]');
            if (await renewTrigger.isVisible()) {
                await renewTrigger.click();
                await page.waitForSelector('#renew-modal.show', { timeout: 5000 });
                await page.waitForTimeout(2000); // 等待动画和组件初始化
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_07_renew_modal_open.png`) });

                // 08. 模态框验证处理 (核心修复点：强制等成功)
                await solveAnyInterceptor(page, safeUser, "08", "模态框验证处理");
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_08_renew_captcha_solved.png`) });

                // 09. 提交续期按钮点击
                await page.locator('#renew-modal button[type="submit"]').click();
                await page.waitForTimeout(2000);
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_09_after_renew_click.png`) });

                // 10. 最终结果
                await page.waitForTimeout(5000);
                const finalShot = path.join(photoDir, `${safeUser}_10_final_result.png`);
                await page.screenshot({ path: finalShot });

                if (TG_BOT_TOKEN) {
                    exec(`curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${finalShot}" -F caption="🤖 ${user.username} 续期流程已记录 (10张快照已备查)"`);
                }
            }
        } catch (err) {
            console.error(`  异常: ${err.message}`);
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_99_error.png`) });
        }
    }
    await browser.close();
    process.exit(0);
})();

async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) return;
    spawn(CHROME_PATH, [`--remote-debugging-port=${DEBUG_PORT}`, '--no-sandbox', '--disable-gpu', '--window-size=1280,720', '--user-data-dir=/tmp/chrome_user_data'], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 20; i++) { if (await checkPort(DEBUG_PORT)) break; await new Promise(r => setTimeout(r, 1000)); }
}
function checkPort(port) { return new Promise(r => { http.get(`http://localhost:${port}/json/version`, () => r(true)).on('error', () => r(false)).end(); }); }
