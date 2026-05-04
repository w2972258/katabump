const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

// 环境准备
const photoDir = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

// --- 借鉴原版的注入脚本：精准捕获影子 DOM 内的验证码坐标 ---
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const observer = new MutationObserver(() => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"], #challenge-stage, .ctp-checkbox-label');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            window.__captcha_pos = {
                                x: rect.left + rect.width / 2,
                                y: rect.top + rect.height / 2
                            };
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
 * 综合破解函数：融合 CDP 点击与 Token 监控
 */
async function solveCaptchas(page) {
    console.log('  >> 正在执行深度扫描 (融合原版 CDP 技术)...');
    const startTime = Date.now();
    const timeout = 35000;

    while (Date.now() - startTime < timeout) {
        const frames = page.frames();
        for (const frame of frames) {
            try {
                // 1. 逻辑判定：检查 Token 是否已生成
                const tokenReady = await frame.evaluate(() => {
                    const input = document.querySelector('[name*="turnstile-response"]');
                    return input && input.value.length > 20;
                }).catch(() => false);

                if (tokenReady) {
                    console.log('  >> ✅ 逻辑确认：Token 已就绪');
                    return true;
                }

                // 2. 交互逻辑：如果没过，尝试点击
                if (frame.url().includes('cloudflare') || frame.url().includes('challenge')) {
                    // 借鉴原版：尝试从注入的 window 变量获取精准坐标
                    const pos = await frame.evaluate(() => window.__captcha_pos).catch(() => null);
                    
                    if (pos) {
                        console.log('  >> 借鉴原版技术：捕获到影子 DOM 坐标，执行 CDP 点击...');
                        const iframeElement = await frame.frameElement();
                        const box = await iframeElement.boundingBox();
                        if (box) {
                            const client = await page.context().newCDPSession(page);
                            const clickX = box.x + pos.x;
                            const clickY = box.y + pos.y;
                            
                            // 使用 CDP 原生事件模拟点击，绕过 JS 监测
                            await client.send('Input.dispatchMouseEvent', {
                                type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1
                            });
                            await page.waitForTimeout(100);
                            await client.send('Input.dispatchMouseEvent', {
                                type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1
                            });
                            await client.detach();
                            console.log('  >> CDP 事件已发送，等待状态切换...');
                            await page.waitForTimeout(3000);
                        }
                    }
                }
            } catch (e) {}
        }

        // ALTCHA 适配
        const altcha = page.locator('altcha-widget').first();
        if (await altcha.isVisible({timeout: 100}).catch(()=>false)) {
            if (await altcha.getAttribute('state') === 'verified') return true;
            const box = await altcha.boundingBox();
            if (box) await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.5);
        }

        await page.waitForTimeout(1500);
    }
    return false;
}

// 启动 Chrome
async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) return;
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`, '--no-sandbox', '--disable-gpu',
        '--user-data-dir=/tmp/chrome_user_data', '--disable-dev-shm-usage',
        '--window-size=1280,720'
    ];
    if (process.env.HTTP_PROXY) args.push(`--proxy-server=${process.env.HTTP_PROXY}`);
    spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 20; i++) { if (await checkPort(DEBUG_PORT)) break; await new Promise(r => setTimeout(r, 1000)); }
}

function checkPort(port) {
    return new Promise(r => { http.get(`http://localhost:${port}/json/version`, () => r(true)).on('error', () => r(false)).end(); });
}

// 主程序
(async () => {
    console.log('--- Katabump 深度优化版启动 ---');
    const users = JSON.parse(process.env.USERS_JSON || '[]');
    await launchChrome();
    
    const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    const context = browser.contexts()[0];
    // 借鉴原版：添加初始化脚本
    await context.addInitScript(INJECTED_SCRIPT);
    
    const page = context.pages()[0] || await context.newPage();

    for (let user of users) {
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n>>> 处理: ${user.username}`);

        try {
            await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('input[name="email"]', { timeout: 15000 });
            
            await page.locator('input[name="email"]').fill(user.username);
            await page.locator('input[name="password"]').fill(user.password);
            
            await solveCaptchas(page);
            await page.waitForTimeout(2000); 
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_ready.png`) });

            await page.locator('button#submit').click();

            // 精准跳转判定
            try {
                await page.waitForURL(url => 
                    !url.href.includes('/auth/') && (url.href.includes('services') || url.href.includes('dashboard')), 
                    { timeout: 25000 }
                );
                console.log('  ✅ 真正登录成功');
            } catch (e) {
                console.log('  ❌ 登录失败，留在原处');
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_fail.png`) });
                continue;
            }

            // 续期
            await page.goto('https://dashboard.katabump.com/services');
            const seeBtn = page.getByRole('link', { name: 'See' }).first();
            await seeBtn.waitFor({ state: 'visible', timeout: 15000 });
            await seeBtn.click();

            const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
            await renewBtn.waitFor({ timeout: 10000 }).catch(()=>{});

            if (await renewBtn.isVisible()) {
                await renewBtn.click();
                await page.waitForSelector('#renew-modal');
                await page.waitForTimeout(2000);
                await solveCaptchas(page);
                
                const finalShot = path.join(photoDir, `${safeUser}_done.png`);
                await page.screenshot({ path: finalShot });
                await page.locator('#renew-modal button#submit').click();
                console.log('  ✅ 续期已提交');
                await page.waitForTimeout(5000); // 留时间给服务器响应
            } else {
                console.log('  ℹ️ 状态: 暂不需续期');
            }
        } catch (err) {
            console.error(`  异常: ${err.message}`);
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_error.png`) }).catch(()=>{});
        }
    }
    await browser.close();
    process.exit(0);
})();
