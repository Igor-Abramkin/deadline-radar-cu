import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findMediaLink, formatCaption, instagramSources, mediaItems } from "../src/lib/media.mjs";

const url = (text, raw) => ({ type: "url", offset: text.indexOf(raw), length: raw.length });

test("finds a typed-out link to a video site", () => {
  const text = "смотри https://www.instagram.com/reel/abc/ ахах";
  const link = findMediaLink(text, [url(text, "https://www.instagram.com/reel/abc/")]);
  assert.deepEqual(link, { url: "https://www.instagram.com/reel/abc/", raw: "https://www.instagram.com/reel/abc/" });
});

test("adds a scheme to bare links and reads hidden ones", () => {
  const bare = "youtu.be/xyz";
  assert.equal(findMediaLink(bare, [url(bare, bare)]).url, "https://youtu.be/xyz");
  const hidden = "вот это";
  const link = findMediaLink(hidden, [{ type: "text_link", offset: 0, length: 7, url: "https://vm.tiktok.com/Z1/" }]);
  assert.deepEqual(link, { url: "https://vm.tiktok.com/Z1/", raw: null });
});

test("ignores other sites and messages without links", () => {
  const text = "https://example.com/youtube.com https://notx.com/a";
  assert.equal(findMediaLink(text, [url(text, "https://example.com/youtube.com"), url(text, "https://notx.com/a")]), null);
  assert.equal(findMediaLink("просто текст", undefined), null);
});

test("caption keeps the author, the comment and the source", () => {
  const raw = "https://x.com/a/status/1";
  const link = { url: raw, raw };
  assert.equal(formatCaption({ name: "Аня <3", text: raw, link }), `<b>Аня &lt;3</b>\n<a href="${raw}">Источник</a>`);
  assert.equal(formatCaption({ name: "Аня", text: `${raw}  лол`, link }), `<b>Аня</b>: лол\n<a href="${raw}">Источник</a>`);
});

test("in a private chat the caption has no author", () => {
  const raw = "https://x.com/a/status/1";
  const link = { url: raw, raw };
  assert.equal(formatCaption({ name: null, text: raw, link }), `<a href="${raw}">Источник</a>`);
  assert.equal(formatCaption({ name: null, text: `лол ${raw}`, link }), `лол\n<a href="${raw}">Источник</a>`);
  const long = formatCaption({ name: null, text: `${raw} ${"а".repeat(2000)}`, link });
  assert.ok(long.length <= 1024 && long.startsWith("ааа"));
});

test("long comments are cut to fit a caption", () => {
  const raw = "https://youtu.be/a";
  const caption = formatCaption({ name: "Аня", text: `${raw} ${"а".repeat(2000)}`, link: { url: raw, raw } });
  assert.ok(caption.length <= 1024);
  assert.ok(caption.endsWith(`<a href="${raw}">Источник</a>`));
});

test("instagram carousel: photos from the last thumbnail, videos from an mp4 with sound", () => {
  const photo = (id) => ({ id, formats: [], thumbnails: [{ url: `${id}-small` }, { url: `${id}-full` }] });
  const video = {
    id: "v",
    duration: 12,
    formats: [
      { url: "dash-video", ext: "mp4", vcodec: "avc1", acodec: "none", height: 1920 },
      { url: "progressive-720", ext: "mp4", vcodec: "avc1", acodec: "mp4a", width: 720, height: 1280 },
      { url: "progressive-1080", ext: "mp4", vcodec: "avc1", acodec: "mp4a", width: 1080, height: 1080 },
    ],
  };
  assert.deepEqual(instagramSources({ _type: "playlist", entries: [photo("a"), video, photo("b")] }), [
    { type: "photo", url: "a-full", ext: "jpg" },
    { type: "video", url: "progressive-1080", ext: "mp4", width: 1080, height: 1080, duration: 12 },
    { type: "photo", url: "b-full", ext: "jpg" },
  ]);
  assert.deepEqual(instagramSources(photo("single")), [{ type: "photo", url: "single-full", ext: "jpg" }]);
});

test("album keeps photos and videos in order, drops the rest, caps at 10", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "media-test-"));
  const file = (name, bytes = 10) => {
    const p = path.join(dir, name);
    writeFileSync(p, Buffer.alloc(bytes));
    return p;
  };
  try {
    const files = [file("1.jpg"), file("2.gif"), file("3.mp4"), file("4.png", 11 * 1024 * 1024), file("5.webp")];
    assert.deepEqual(mediaItems(files).map((i) => [i.type, path.basename(i.file)]), [
      ["photo", "1.jpg"],
      ["video", "3.mp4"],
      ["photo", "5.webp"],
    ]);
    const many = Array.from({ length: 12 }, (_, i) => file(`p${i}.jpg`));
    assert.equal(mediaItems(many).length, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
