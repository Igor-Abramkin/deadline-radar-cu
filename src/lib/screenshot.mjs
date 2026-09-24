// Screenshot of a web page for contest posts: people see the live cards and
// votes, not just numbers. Returns a JPEG buffer, or null when there's no
// browser (the post then goes out as text).
const MAX_HEIGHT = 2400;

export async function screenshot(url) {
  let browser;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 2,
      locale: "ru-RU",
      colorScheme: "dark",
    });
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    // Tall pages get cut: Telegram shrinks long photos until nothing is readable.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    return await page.screenshot({
      type: "jpeg",
      fullPage: true,
      quality: 85,
      clip: { x: 0, y: 0, width: 1280, height: Math.min(height, MAX_HEIGHT) },
    });
  } catch (err) {
    console.error("screenshot failed:", err.message);
    return null;
  } finally {
    await browser?.close().catch(() => {});
  }
}
