import { launch } from '@cloudflare/playwright';
import type { Cookie } from '@cloudflare/playwright';

interface InputCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string | null;
  expirationDate?: number;
  session?: boolean;
}

interface LikeRequest {
  url: string;
  cookies: InputCookie[];
}

function mapSameSite(value: string | null | undefined): Cookie['sameSite'] | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === 'no_restriction' || normalized === 'none') return 'None';
  if (normalized === 'lax') return 'Lax';
  if (normalized === 'strict') return 'Strict';
  return undefined;
}

function toPlaywrightCookies(cookies: InputCookie[]): Cookie[] {
  const seen = new Set<string>();
  const result: Cookie[] = [];

  for (const cookie of cookies) {
    const key = `${cookie.domain}|${cookie.path ?? '/'}|${cookie.name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    result.push({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path ?? '/',
      expires: cookie.expirationDate && !cookie.session ? cookie.expirationDate : -1,
      httpOnly: cookie.httpOnly ?? false,
      secure: cookie.secure ?? true,
      sameSite: mapSameSite(cookie.sameSite) ?? 'Lax',
    });
  }

  return result;
}

function isTweetUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === 'x.com' || parsed.hostname === 'twitter.com' || parsed.hostname.endsWith('.x.com')) &&
      /\/status\/\d+/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

async function likeTweet(page: Awaited<ReturnType<Awaited<ReturnType<typeof launch>>['newPage']>>) {
  const unlikeButton = page.locator('[data-testid="unlike"]').first();
  if (await unlikeButton.isVisible().catch(() => false)) {
    return { alreadyLiked: true };
  }

  const likeButton = page.locator('[data-testid="like"]').first();
  await likeButton.waitFor({ state: 'visible', timeout: 30000 });
  await likeButton.click();
  await unlikeButton.waitFor({ state: 'visible', timeout: 10000 });

  return { alreadyLiked: false };
}

export default {
  async fetch(request: Request, env: Env) {
    if (request.method !== 'POST') {
      return Response.json(
        { error: '请使用 POST，请求体格式: { "url": "推文链接", "cookies": [...] }' },
        { status: 405 },
      );
    }

    let body: LikeRequest;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: '请求体必须是合法 JSON' }, { status: 400 });
    }

    if (!body.url || !Array.isArray(body.cookies) || body.cookies.length === 0) {
      return Response.json({ error: 'url 和 cookies 为必填项' }, { status: 400 });
    }

    if (!isTweetUrl(body.url)) {
      return Response.json(
        { error: 'url 必须是 X/Twitter 推文链接，例如 https://x.com/user/status/123' },
        { status: 400 },
      );
    }

    const browser = await launch(env.MYBROWSER);

    try {
      const context = await browser.newContext({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      });
      await context.addCookies(toPlaywrightCookies(body.cookies));

      const page = await context.newPage();
      await page.goto(body.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 30000 });

      const result = await likeTweet(page);

      // 等待点赞动画/UI 更新后再截图
      await page.waitForTimeout(500);
      const img = await page.screenshot({ fullPage: true });

      return new Response(new Uint8Array(img), {
        headers: {
          'Content-Type': 'image/png',
          'X-Success': 'true',
          'X-Already-Liked': String(result.alreadyLiked),
          'X-Url': body.url,
        },
      });
    } catch (error) {
      return Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      );
    } finally {
      await browser.close();
    }
  },
};
