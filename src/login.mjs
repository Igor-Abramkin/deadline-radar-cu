// One-time interactive login. Opens a real browser window: pass the captcha
// yourself, the script fills credentials and saves the session to data/session.json.
import { chromium } from "playwright";

const SESSION = "data/session.json";
const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ locale: "ru-RU" });
const page = await ctx.newPage();
await page.goto("https://my.centraluniversity.ru/learn/courses/view/actual/all");

let filled = false;
const deadline = Date.now() + 10 * 60_000;
while (Date.now() < deadline) {
  const url = page.url();
  if (url.startsWith("https://my.centraluniversity.ru/learn")) {
    const res = await page.request.get("https://my.centraluniversity.ru/api/micro-lms/students/me");
    if (res.ok()) break;
  }
  if (!filled && url.includes("id.centraluniversity.ru") && !url.includes("captcha")) {
    const user = page.locator('input[name="username"], input[type="email"]').first();
    if (await user.isVisible().catch(() => false)) {
      await user.fill(process.env.CU_LOGIN);
      await page.locator('input[type="password"]').first().fill(process.env.CU_PASSWORD);
      await page.locator('button[type="submit"], input[type="submit"]').first().click();
      filled = true;
    }
  }
  await page.waitForTimeout(1000);
}

await ctx.storageState({ path: SESSION });
const cookies = (await ctx.cookies()).map((c) => `${c.domain} ${c.name} expires=${c.expires > 0 ? new Date(c.expires * 1000).toISOString() : "session"}`);
console.log("saved", SESSION, "\n" + cookies.join("\n"));
await browser.close();

const { saveCookieFromSession } = await import("./lib/lms.mjs");
saveCookieFromSession();
const { readFileSync } = await import("node:fs");
console.log("\nСессия сохранена. Чтобы обновить её на сервере, отправь боту в личку:\n");
console.log(`/session ${readFileSync("data/cookie.txt", "utf8").trim()}\n`);
