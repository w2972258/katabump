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

/**
 * 验证码处理器：专门针对源码中的 <altcha-widget>
 */
async function solveAltcha(page, stepName) {
    console.log(`  >> [${stepName}] 正在处理 ALTCHA 验证码...`);
    try {
        const widget = page.locator('altcha-widget').first();
        await widget.waitFor({ state: 'visible', timeout: 10000 });
        
        // 获取位置并执行人类化点击 (点击左侧复选框区域)
        const box = await widget.boundingBox();
        if (box) {
            await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.5);
            console.log('  >> 已点击验证码，等待 PoW 计算...');
            
            // 等待状态变为 verified
            for (let i = 0; i < 20; i++) {
                const state = await widget.getAttribute('state');
                if (state === 'verified') {
                    console.log('  >> ✅ 验证码计算完成！');
                    return true;
                }
                await page.waitForTimeout(1000);
            }
        }
    } catch (e) {
        console.log(`  >> 验证码处理异常: ${e.message}`);
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
    console.log('--- 基于源码校准的全流程监控版启动 ---');
    const users = JSON.parse(process.env.USERS_JSON || '[]');
    await launchChrome();
    const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();

    for (let user of users) {
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n>>> 用户: ${user.username}`);

        try {
            // 1. 登录页快照
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_01_login_form.png`) });

            await page.locator('input[name="email"]').fill(user.username);
            await page.locator('input[name="password"]').fill(user.password);
            
            // 处理登录页验证码 (如果是 ALTCHA)
            await solveAltcha(page, "登录");
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_02_login_ready.png`) });

            await page.locator('button#submit').click();
            await page.waitForTimeout(5000);
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_03_after_login.png`) });

            // 2. 进入主面板
            console.log('  正在访问 Dashboard...');
            await page.goto('https://dashboard.katabump.com/dashboard');
            await page.waitForTimeout(3000);
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_04_dashboard.png`) });

            // 寻找进入服务器详情的链接 (对应源码中的 "See" 逻辑)
            const seeBtn = page.getByRole('link', { name: 'See' }).first();
            if (await seeBtn.isVisible()) {
                await seeBtn.click();
                await page.waitForTimeout(3000);
                await page.screenshot({ path: path.join(photoDir, `${safeUser}_05_server_detail.png`) });

                // 3. 触发续期模态框 (基于源码中的 class 和 data-bs-target)
                const renewBtnTrigger = page.locator('button[data-bs-target="#renew-modal"]');
                if (await renewBtnTrigger.isVisible()) {
                    await renewBtnTrigger.click();
                    console.log('  已触发续期模态框');
                    
                    // 等待模态框动画结束
                    await page.waitForSelector('#renew-modal.show', { timeout: 5000 });
                    await page.waitForTimeout(1000);
                    await page.screenshot({ path: path.join(photoDir, `${safeUser}_06_renew_modal_open.png`) });

                    // 4. 解决模态框内的 ALTCHA
                    await solveAltcha(page, "续期确认");
                    await page.screenshot({ path: path.join(photoDir, `${safeUser}_07_renew_captcha_done.png`) });

                    // 5. 提交表单 (源码中模态框内的按钮也是 Renew 文本)
                    await page.locator('#renew-modal button.btn-primary').click();
                    console.log('  续期表单已提交');
                    
                    await page.waitForTimeout(5000);
                    await page.screenshot({ path: path.join(photoDir, `${safeUser}_08_final_result.png`) });
                    
                    // 发送成功通知
                    if (TG_BOT_TOKEN) {
                        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${path.join(photoDir, `${safeUser}_08_final_result.png`)}" -F caption="✅ 用户 ${user.username} 续期流程完成"`;
                        exec(cmd);
                    }
                } else {
                    console.log('  ℹ️ 状态: 当前无法续期 (未找到 Renew 按钮)');
                }
            } else {
                console.log('  ❌ 错误: 未能在 Dashboard 找到服务器链接');
            }
        } catch (err) {
            console.error(`  运行时异常: ${err.message}`);
            await page.screenshot({ path: path.join(photoDir, `${safeUser}_99_exception.png`) }).catch(()=>{});
        }
    }
    await browser.close();
    process.exit(0);
})();
