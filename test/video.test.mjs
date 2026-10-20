import { test } from "node:test";
import assert from "node:assert/strict";
import { findVideoLink, formatCaption } from "../src/lib/video.mjs";

const url = (text, raw) => ({ type: "url", offset: text.indexOf(raw), length: raw.length });

test("finds a typed-out link to a video site", () => {
  const text = "смотри https://www.instagram.com/reel/abc/ ахах";
  const link = findVideoLink(text, [url(text, "https://www.instagram.com/reel/abc/")]);
  assert.deepEqual(link, { url: "https://www.instagram.com/reel/abc/", raw: "https://www.instagram.com/reel/abc/" });
});

test("adds a scheme to bare links and reads hidden ones", () => {
  const bare = "youtu.be/xyz";
  assert.equal(findVideoLink(bare, [url(bare, bare)]).url, "https://youtu.be/xyz");
  const hidden = "вот это";
  const link = findVideoLink(hidden, [{ type: "text_link", offset: 0, length: 7, url: "https://vm.tiktok.com/Z1/" }]);
  assert.deepEqual(link, { url: "https://vm.tiktok.com/Z1/", raw: null });
});

test("ignores other sites and messages without links", () => {
  const text = "https://example.com/youtube.com https://notx.com/a";
  assert.equal(findVideoLink(text, [url(text, "https://example.com/youtube.com"), url(text, "https://notx.com/a")]), null);
  assert.equal(findVideoLink("просто текст", undefined), null);
});

test("caption keeps the author, the comment and the source", () => {
  const raw = "https://x.com/a/status/1";
  const link = { url: raw, raw };
  assert.equal(formatCaption({ name: "Аня <3", text: raw, link }), `<b>Аня &lt;3</b>\n<a href="${raw}">Источник</a>`);
  assert.equal(formatCaption({ name: "Аня", text: `${raw}  лол`, link }), `<b>Аня</b>: лол\n<a href="${raw}">Источник</a>`);
});

test("long comments are cut to fit a caption", () => {
  const raw = "https://youtu.be/a";
  const caption = formatCaption({ name: "Аня", text: `${raw} ${"а".repeat(2000)}`, link: { url: raw, raw } });
  assert.ok(caption.length <= 1024);
  assert.ok(caption.endsWith(`<a href="${raw}">Источник</a>`));
});
