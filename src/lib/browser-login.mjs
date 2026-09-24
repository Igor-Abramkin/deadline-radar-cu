// Interactive LMS login. Opens a real browser window: the captcha and the SMS
// code are passed by hand, credentials are prefilled when given. Saves the
// browser session to data/session.json and the bff.cookie to data/cookie.txt.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

const DATA_DIR = process.env.DATA_DIR || "data";
const SESSION = `${DATA_DIR}/session.json`;
const LMS = "https://my.centraluniversity.ru";

// `bun install` doesn't fetch the browser itself, so the first login does it.
export function ensureChromium() {
  if (existsSync(chromium.executablePath())) return;
  const res = spawnSync("bunx", ["playwright", "install", "chromium"], { stdio: "inherit" });
  if (res.status !== 0) throw new Error("не удалось установить Chromium: запусти `bunx playwright install chromium`");
}

export async function loginInBrowser({ login, password, timeoutMin = 10 } = {}) {
  ensureChromium();
  mkdirSync(DATA_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ locale: "ru-RU" });
  const page = await ctx.newPage();
  await page.goto(`${LMS}/learn/courses/view/actual/all`);

  let filled = !login || !password;
  let ok = false;
  const deadline = Date.now() + timeoutMin * 60_000;
  while (Date.now() < deadline) {
    if (page.isClosed()) break;
    const url = page.url();
    if (url.startsWith(`${LMS}/learn`)) {
      const res = await page.request.get(`${LMS}/api/micro-lms/students/me`).catch(() => null);
      if (res?.ok()) {
        ok = true;
        break;
      }
    }
    if (!filled && url.includes("id.centraluniversity.ru") && !url.includes("captcha")) {
      const user = page.locator('input[name="username"], input[type="email"]').first();
      if (await user.isVisible().catch(() => false)) {
        await user.fill(login);
        await page.locator('input[type="password"]').first().fill(password);
        await page.locator('button[type="submit"], input[type="submit"]').first().click();
        filled = true;
      }
    }
    await page.waitForTimeout(1000).catch(() => {});
  }

  if (!ok) {
    await browser.close().catch(() => {});
    throw new Error("не дождался входа в LMS: окно закрыто или вышло время");
  }
  await ctx.storageState({ path: SESSION });
  await browser.close();

  const { saveCookieFromSession } = await import("./lms.mjs");
  saveCookieFromSession();
  return readFileSync(`${DATA_DIR}/cookie.txt`, "utf8").trim();
}
