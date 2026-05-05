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
 * 核心：拦截框实时处理器
 * 每到一个新页面或动作后调用，确保拦截码已解决。
 */
async function solveAnyInterceptor(page, safeUser, stepId, stepName) {
    console.log(`  >> [${stepId}] 拦截检查: ${stepName}...`);
    const startTime = Date.now();
    const timeout = 45000; // 每个拦截点最多等 45s

    while (Date.now() - startTime < timeout) {
        let activeCaptcha = false;

        // 1. 检测 Cloudflare (通过 Token 或 影子 DOM 坐标)
        const frames = page.frames();
        for (const frame of frames) {
            const token = await frame.evaluate(() => {
                const input = document.querySelector('[name*="turnstile-response"]');
                return input && input.value.length > 20;
            }).catch(() => false);

            if (token) {
                console.log(`  >> [${stepId}] Cloudflare 逻辑验证通过`);
                return true;
            }

            const pos = await frame.evaluate(() => window.__captcha_pos).catch(() => null);
            if (pos) {
                activeCaptcha = true;
                const fEl = await frame.frameElement();
                const box = await fEl.boundingBox();
                if (box) {
                    console.log(`  >> [${stepId}] 检测到 Cloudflare 悬浮，执行 CDP 点击...`);
                    const client = await page.context().newCDPSession(page);
                    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x + pos.x, y: box.y + pos.y, button: 'left', clickCount: 1 });
                    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + pos.x, y: box.y + pos.y, button: 'left', clickCount: 1 });
                    await client.detach();
                    await page.waitForTimeout(4000); // 点击后强制观察
                }
            }
        }

        // 2. 检测 ALTCHA (针对续期模态框)
        const altcha = page.locator('altcha-widget').first();
        if (await altcha.isVisible({timeout: 500}).catch(()=>false)) {
            const state = await altcha.getAttribute('state');
            if (state === 'verified') {
                console.log(`  >> [${stepId}] ALTCHA 验证状态: Success`);
                return true;
            }
            activeCaptcha = true;
            if (state !== 'computing') {
                console.log(`  >> [${stepId}] 点击 ALTCHA 复选框...`);
                const box = await altcha.boundingBox();
                if (box) {
                    await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.5);
                    await page.waitForTimeout(3000);
                }
            }
        }

        // 如果没有发现任何拦截元素，且已等待至少 3 秒，认为页面目前是干净的
        if (!activeCaptcha && Date.now() - startTime > 3000) {
            console.log(`  >> [${stepId}] 未发现拦截框，放行`);
            return true;
        }
        await page.waitForTimeout(1500);
    }
    return false;
}

// 辅助：启动与端口检查 (省略重复逻辑...)
async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) return;
    spawn(CHROME_PATH, [`--remote-debugging-port=${DEBUG_PORT}`, '--no-sandbox', '--disable-gpu', '--window-size=1280,720', '--user-data-dir=/tmp/chrome_user_data'], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 20; i++) { if (await checkPort(DEBUG_PORT)) break; await new Promise(r => setTimeout(r, 1000)); }
}
function checkPort(port) { return new Promise(r => { http.get(`http://localhost:${port}/json/version`, () => r(true)).on('error', () => r(false)).end(); }); }

(async () => {
    const users = JSON.parse(process.env.USERS_JSON || '[]');
    await launchChrome();
    const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    const context = browser.contexts()[0];
    await context.addInitScript(INJECTED_SCRIPT);
    const page = context.pages()[0] || await context.newPage();

    for (let user of users) {
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n>>> 开始处理用户: ${user.username}`);

        try {
            // --- 阶段一：登录环节 ---
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_01_login_load.png`) });
            
            // 跳转新页，检查是否有入口拦截
            await solveAnyInterceptor(page, safeUser, "02", "登录页入口检查");
            
            await page.locator('input[name="email"]').fill(user.username);
            await page.locator('input[name="password"]').fill(user.password);
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_03_creds_filled.png`) });

            // 提交前再次确认拦截框是否勾选成功
            await solveAnyInterceptor(page, safeUser, "04", "点击登录前检查");
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_04_login_ready.png`) });

            await page.locator('button#submit').click();
            await page.waitForTimeout(4000);
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_05_after_login_click.png`) });

            // --- 阶段二：Dashboard 环节 ---
            await page.waitForURL(url => !url.href.includes('/auth/'), { timeout: 20000 });
            console.log('  ✅ 成功进入后台');
            
            // 进入 Dashboard 可能也有拦截
            await solveAnyInterceptor(page, safeUser, "06", "Dashboard拦截检查");
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_06_dashboard_main.png`) });

            // --- 阶段三：详情页环节 ---
            const seeBtn = page.locator('table a:has-text("See"), .btn-outline-primary').first();
            await seeBtn.click();
            await page.waitForTimeout(3000);
            
            // 进入新页面（详情页），检查拦截
            await solveAnyInterceptor(page, safeUser, "07", "服务器详情页检查");
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_07_server_detail.png`) });

            // --- 阶段四：续期模态框环节 ---
            const renewTrigger = page.locator('button[data-bs-target="#renew-modal"]');
            if (await renewTrigger.isVisible()) {
                await renewTrigger.click();
                await page.waitForSelector('#renew-modal.show', { timeout: 5000 });
                console.log('  模态框已弹出，准备处理模态框内的 ALTCHA');
                
                // 模态框是一个局部刷新的“新环境”，必须检查拦截
                await solveAnyInterceptor(page, safeUser, "08", "模态框内部检查");
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_08_renew_checked.png`) });

                console.log('  执行最终续期提交...');
                await page.locator('#renew-modal button[type="submit"]').click();
                await page.waitForTimeout(3000);
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_09_after_renew_click.png`) });

                // 等待最终反馈结果
                await page.waitForTimeout(4000);
                const finalShot = path.join(photoDir, `${safeUser}_10_final_result.png`);
                await page.screenshot({ path: finalShot });
                console.log('  ✅ 续期流程完整结束');

                if (TG_BOT_TOKEN) {
                    exec(`curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${finalShot}" -F caption="🤖 ${user.username} 续期完毕"`);
                }
            }
        } catch (err) {
            console.error(`  异常报告: ${err.message}`);
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_99_error.png`) });
        }
    }
    await browser.close();
    process.exit(0);
})();
