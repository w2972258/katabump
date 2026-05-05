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
 * 终极验证码处理器：在任何步骤调用，确保页面干净
 */
async function ensureCaptchaSolved(page, stepName) {
    console.log(`  >> [检查点: ${stepName}] 正在扫描拦截框...`);
    const startTime = Date.now();
    const timeout = 40000; // 给足 40 秒处理时间

    while (Date.now() - startTime < timeout) {
        let foundAnything = false;

        // --- 1. 扫描所有 Frame (针对 Cloudflare) ---
        const frames = page.frames();
        for (const frame of frames) {
            try {
                // 检查 Token
                const tokenReady = await frame.evaluate(() => {
                    const input = document.querySelector('[name*="turnstile-response"]');
                    return input && input.value.length > 20;
                }).catch(() => false);
                if (tokenReady) {
                    console.log(`  >> [${stepName}] Cloudflare 已通过 (Token 确认)`);
                    return true;
                }

                // 尝试 CDP 点击
                const pos = await frame.evaluate(() => window.__captcha_pos).catch(() => null);
                if (pos) {
                    const fEl = await frame.frameElement();
                    const box = await fEl.boundingBox();
                    if (box) {
                        console.log(`  >> [${stepName}] 发现 Cloudflare，执行底层点击...`);
                        const client = await page.context().newCDPSession(page);
                        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x + pos.x, y: box.y + pos.y, button: 'left', clickCount: 1 });
                        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + pos.x, y: box.y + pos.y, button: 'left', clickCount: 1 });
                        await client.detach();
                        await page.waitForTimeout(4000);
                        foundAnything = true;
                    }
                }
            } catch (e) {}
        }

        // --- 2. 扫描主页面/模态框 (针对 ALTCHA) ---
        const altcha = page.locator('altcha-widget').first();
        if (await altcha.isVisible({timeout: 500}).catch(()=>false)) {
            const state = await altcha.getAttribute('state');
            if (state === 'verified') {
                console.log(`  >> [${stepName}] ALTCHA 已通过`);
                return true;
            }
            if (state !== 'computing') {
                console.log(`  >> [${stepName}] 发现未激活的 ALTCHA，准备点击...`);
                const box = await altcha.boundingBox();
                if (box) {
                    await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.5);
                    await page.waitForTimeout(3000);
                    foundAnything = true;
                }
            } else {
                console.log(`  >> [${stepName}] ALTCHA 正在计算中...`);
            }
        }

        if (!foundAnything && Date.now() - startTime > 5000) {
            // 如果 5 秒后还没发现任何验证码，假设页面目前是干净的
            console.log(`  >> [${stepName}] 未发现拦截框，继续流程`);
            return true;
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
    console.log('--- 终极全生命周期拦截版启动 ---');
    const users = JSON.parse(process.env.USERS_JSON || '[]');
    await launchChrome();
    const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    const context = browser.contexts()[0];
    await context.addInitScript(INJECTED_SCRIPT);
    const page = context.pages()[0] || await context.newPage();

    for (let user of users) {
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n>>> 正在处理用户: ${user.username}`);

        try {
            // 步骤 1: 登录页
            await page.goto('https://dashboard.katabump.com/auth/login');
            await ensureCaptchaSolved(page, "登录页加载"); // 进入页面先扫一遍
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_01_login_page.png`) });

            await page.locator('input[name="email"]').fill(user.username);
            await page.locator('input[name="password"]').fill(user.password);
            
            await ensureCaptchaSolved(page, "提交登录前"); // 点击前再确认
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_02_login_ready.png`) });

            await page.locator('button#submit').click();
            await page.waitForTimeout(5000);

            // 步骤 2: Dashboard 确认
            await page.waitForURL(url => !url.href.includes('/auth/'), { timeout: 20000 });
            console.log('  ✅ 登录成功');
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_03_dashboard.png`) });

            // 步骤 3: 进入详情页
            await page.goto('https://dashboard.katabump.com/dashboard'); // 源码显示主页就是详情页入口
            const seeBtn = page.locator('table a:has-text("See"), table a:has-text("Manage"), .btn-outline-primary').first();
            await seeBtn.waitFor({ state: 'visible' });
            await seeBtn.click();
            
            await page.waitForTimeout(3000);
            await ensureCaptchaSolved(page, "服务器详情页"); // 详情页可能也有拦截
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_04_server_detail.png`) });

            // 步骤 4: 触发续期模态框
            const renewBtnTrigger = page.locator('button[data-bs-target="#renew-modal"]');
            if (await renewBtnTrigger.isVisible()) {
                await renewBtnTrigger.click();
                await page.waitForSelector('#renew-modal.show', { timeout: 5000 });
                console.log('  已打开模态框，等待验证码...');
                
                // 步骤 5: 模态框内的死等验证
                await page.waitForTimeout(2000); 
                await ensureCaptchaSolved(page, "模态框内部"); 
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_05_renew_ready_to_click.png`) });

                // 步骤 6: 提交续期
                console.log('  点击最终续期按钮...');
                await page.locator('#renew-modal button[type="submit"]').click();
                
                await page.waitForTimeout(6000);
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_06_final_result.png`) });
                console.log('  ✅ 续期全流程已结束');

                if (TG_BOT_TOKEN) {
                    exec(`curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${path.join(photoDir, `${safeUser}_06_final_result.png`)}" -F caption="🤖 ${user.username} 续期任务结果汇报"`);
                }
            } else {
                console.log('  ℹ️ 状态: 暂无需续期');
            }
        } catch (err) {
            console.error(`  异常报告: ${err.message}`);
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_99_error.png`) }).catch(()=>{});
        }
    }
    await browser.close();
    process.exit(0);
})();
