import { launch } from '@cloudflare/playwright';

export default {
  async fetch(request: Request, env: Env) {
    const browser = await launch(env.MYBROWSER);
    const page = await browser.newPage();
    
    // 打开 Google News
    await page.goto('https://news.google.com');
    
    // 可选：等待页面关键内容加载完成，避免截图不完整
    // await page.waitForLoadState('networkidle');
    
    // 截图（fullPage: true 为整页截图，去掉则只截当前视口）
    const img = await page.screenshot({ fullPage: true });
    await browser.close();

    return new Response(new Uint8Array(img), {
      headers: {
        'Content-Type': 'image/png',
      },
    });
  },
};
