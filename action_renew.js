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

// 借鉴原版：影子 DOM 坐标监控脚本
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
 * 全能验证码处理器：自动识别 Cloudflare 或 ALTCHA
 */
async function solveUniversalCaptcha(page, stepName) {
    console.log(`  >> [${stepName}] 正在扫描验证码类型...`);
    const startTime = Date.now();
    const timeout = 35000;

    while (Date.now() - startTime < timeout) {
        const frames = page.frames();
        for (const frame of frames) {
            try {
                // 1. 逻辑判定：检查 Cloudflare Token 是否已生成
                const tokenReady = await frame.evaluate(() => {
                    const input = document.querySelector('[name*="turnstile-response"]');
                    return input && input.value.length > 20;
                }).catch(() => false);
                if (tokenReady) return { type: 'Cloudflare', status: 'Success' };

                // 2. 检查 ALTCHA 状态
                const altcha = page.locator('altcha-widget').first();
                if (await altcha.isVisible({timeout: 100}).catch(()=>false)) {
                    if (await altcha.getAttribute('state') === 'verified') return { type: 'ALTCHA', status: 'Success' };
                    // 如果没过，执行点击
                    const box = await altcha.boundingBox();
                    if (box) await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.5);
                }

                // 3. 针对 Cloudflare 执行 CDP 模拟点击 (借鉴原版)
                if (frame.url().includes('cloudflare') || frame.url().includes('challenge')) {
                    const pos = await frame.evaluate(() => window.__captcha_pos).catch(() => null);
                    if (pos) {
                        const iframeElement = await frame.frameElement();
                        const fBox = await iframeElement.boundingBox();
                        if (fBox) {
                            const client = await page.context().newCDPSession(page);
                            await client.send('Input.dispatchMouseEvent', {
                                type: 'mousePressed', x: fBox.x + pos.x, y: fBox.y + pos.y, button: 'left', clickCount: 1
                            });
                            await page.waitForTimeout(100);
                            await client.send('Input.dispatchMouseEvent', {
                                type: 'mouseReleased', x: fBox.x + pos.x, y: fBox.y + pos.y, button: 'left', clickCount: 1
                            });
                            await client.detach();
                            await page.waitForTimeout(3000);
                        }
                    }
                }
            } catch (e) {}
        }
        await page.waitForTimeout(1500);
    }
    return { status: 'Timeout' };
}

async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) return;
    const args = [`--remote-debugging-port=${DEBUG_PORT}`, '--no-sandbox', '--disable-gpu', '--window-size=1280,720', '--user-data-dir=/tmp/chrome_user_data'];
    spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 20; i++) { if (await checkPort(DEBUG_PORT)) break; await new Promise(r => setTimeout(r, 1000)); }
}

function checkPort(port) { return new Promise(r => { http.get(`http://localhost:${port}/json/version`, () => r(true)).on('error', () => r(false)).end(); }); }

(async () => {
    console.log('--- 融合版全流程监控脚本启动 ---');
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
            // 步骤 1：打开登录页
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_01_login_form.png`) });

            await page.locator('input[name="email"]').fill(user.username);
            await page.locator('input[name="password"]').fill(user.password);
            
            // 步骤 2：全能破解验证码
            await solveUniversalCaptcha(page, "登录阶段");
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_02_ready_to_click.png`) });

            await page.locator('button#submit').click();
            await page.waitForTimeout(5000);
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_03_after_click_login.png`) });

            // 步骤 3：进入 Dashboard
            try {
                // 排除 auth 路径，确保真正登录成功
                await page.waitForURL(url => !url.href.includes('/auth/'), { timeout: 15000 });
                console.log('  ✅ 成功进入控制台');
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_04_dashboard_success.png`) });
            } catch (e) {
                console.log('  ❌ 登录跳转失败，可能验证码未过');
                continue;
            }

            // 步骤 4：进入服务器管理页
            await page.goto('https://dashboard.katabump.com/dashboard');
            const seeBtn = page.getByRole('link', { name: 'See' }).first();
            if (await seeBtn.isVisible()) {
                await seeBtn.click();
                await page.waitForTimeout(3000);
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_05_server_detail.png`) });

                // 步骤 5：处理续期模态框
                const renewTrigger = page.locator('button[data-bs-target="#renew-modal"]');
                if (await renewTrigger.isVisible()) {
                    await renewTrigger.click();
                    await page.waitForSelector('#renew-modal.show', { timeout: 5000 });
                    await page.screenshot({ path: path.join(photoDir, `${safeUser}_06_renew_modal_open.png`) });

                    await solveUniversalCaptcha(page, "续期阶段");
                    await page.screenshot({ path: path.join(photoDir, `${safeUser}_07_renew_captcha_solved.png`) });

                    await page.locator('#renew-modal button.btn-primary').click();
                    await page.waitForTimeout(5000);
                    await page.screenshot({ path: path.join(photoDir, `${safeUser}_08_renew_result.png`) });
                    console.log('  ✅ 续期流程已走完');
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
