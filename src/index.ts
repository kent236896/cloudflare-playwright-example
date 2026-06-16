import { launch } from '@cloudflare/playwright';
import type { Cookie, Page } from '@cloudflare/playwright';

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

interface ScreenshotRequest {
  url: string;
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SCREENSHOT_DELAY_MS = 15_000;

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

function parseHttpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

function isTweetUrl(url: string): boolean {
  const parsed = parseHttpUrl(url);
  if (!parsed) return false;
  return (
    (parsed.hostname === 'x.com' || parsed.hostname === 'twitter.com' || parsed.hostname.endsWith('.x.com')) &&
    /\/status\/\d+/.test(parsed.pathname)
  );
}

async function waitBeforeScreenshot(page: Page) {
  await page.waitForLoadState('load');
  await page.waitForTimeout(SCREENSHOT_DELAY_MS);
}

async function takeScreenshot(page: Page, url: string, extraHeaders: Record<string, string> = {}) {
  const img = await page.screenshot({ fullPage: true });
  return new Response(new Uint8Array(img), {
    headers: {
      'Content-Type': 'image/png',
      'X-Success': 'true',
      'X-Url': url,
      ...extraHeaders,
    },
  });
}

async function likeTweet(page: Page) {
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

async function handleScreenshot(request: Request, env: Env) {
  let url: string | undefined;

  if (request.method === 'GET') {
    url = new URL(request.url).searchParams.get('url') ?? undefined;
  } else if (request.method === 'POST') {
    let body: ScreenshotRequest;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: '请求体必须是合法 JSON' }, { status: 400 });
    }
    url = body.url;
  } else {
    return Response.json(
      { error: '请使用 GET ?url= 或 POST { "url": "网站链接" }' },
      { status: 405 },
    );
  }

  if (!url) {
    return Response.json({ error: 'url 为必填项' }, { status: 400 });
  }

  if (!parseHttpUrl(url)) {
    return Response.json({ error: 'url 必须是合法的 http/https 链接' }, { status: 400 });
  }

  const browser = await launch(env.MYBROWSER);

  try {
    const page = await browser.newPage({ userAgent: USER_AGENT });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitBeforeScreenshot(page);
    return await takeScreenshot(page, url);
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
}

async function handleLike(request: Request, env: Env) {
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
    const context = await browser.newContext({ userAgent: USER_AGENT });
    await context.addCookies(toPlaywrightCookies(body.cookies));

    const page = await context.newPage();
    await page.goto(body.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 30000 });

    const result = await likeTweet(page);
    await page.waitForTimeout(500);

    return await takeScreenshot(page, body.url, {
      'X-Already-Liked': String(result.alreadyLiked),
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
}

export default {
  async fetch(request: Request, env: Env) {
    const { pathname, searchParams } = new URL(request.url);

    if (pathname === '/screenshot' || (pathname === '/' && searchParams.has('url'))) {
      return handleScreenshot(request, env);
    }

    if (pathname === '/like') {
      return handleLike(request, env);
    }

    return Response.json(
      {
        error: '未知路径',
        routes: {
          screenshot: 'GET /screenshot?url=https://example.com 或 POST /screenshot { "url": "..." }',
          like: 'POST /like { "url": "...", "cookies": [...] }',
        },
      },
      { status: 404 },
    );
  },
};
