async function solveCaptchas(page) {
    console.log('  >> 正在扫描并破解验证码...');
    
    const frames = page.frames();
    let solved = false;

    for (const frame of frames) {
        // 1. 识别 Cloudflare Turnstile
        if (frame.url().includes('cloudflare.com') || frame.url().includes('turnstile')) {
            try {
                // 定位复选框
                const checkbox = frame.locator('#challenge-stage, .ctp-checkbox-label').first();
                if (await checkbox.isVisible({ timeout: 3000 })) {
                    console.log('  >> 找到 Cloudflare 复选框，准备点击...');
                    
                    // 获取坐标并执行人类化点击
                    const box = await checkbox.boundingBox();
                    if (box) {
                        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                        
                        // 【关键】等待验证成功的标志
                        console.log('  >> 已点击，等待 Cloudflare 验证成功标志...');
                        for (let i = 0; i < 15; i++) {
                            // 检查是否有 "Success" 或者复选框消失/变为勾选状态
                            const content = await frame.content();
                            if (content.includes('Success') || content.includes('verified')) {
                                console.log('  >> ✅ Cloudflare 验证通过！');
                                solved = true;
                                break;
                            }
                            await page.waitForTimeout(1000);
                        }
                    }
                }
            } catch (e) { }
        }

        // 2. 识别 ALTCHA (Katabump 登录页有时也会交替出现这个)
        try {
            const altcha = page.locator('altcha-widget').first();
            if (await altcha.isVisible({ timeout: 1000 })) {
                console.log('  >> 找到 ALTCHA，执行破解...');
                const box = await altcha.boundingBox();
                if (box) {
                    await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.5);
                    for (let i = 0; i < 15; i++) {
                        if (await altcha.getAttribute('state') === 'verified') {
                            console.log('  >> ✅ ALTCHA 验证通过！');
                            solved = true;
                            break;
                        }
                        await page.waitForTimeout(1000);
                    }
                }
            }
        } catch (e) { }
        
        if (solved) break;
    }
    return solved;
}
