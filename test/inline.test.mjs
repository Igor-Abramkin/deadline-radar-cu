import { test } from "node:test";
import assert from "node:assert/strict";
import { cachedResult, failedCaption, inlineCaption, inputMedia, storedItem } from "../src/lib/inline.mjs";

const raw = "https://x.com/a/status/1";
const link = { url: raw, raw };
const source = `<a href="${raw}">Источник</a>`;

test("inline caption keeps the comment and the link, no author", () => {
  assert.equal(inlineCaption(`${raw} лол`, link), `лол\n${source}`);
  assert.equal(inlineCaption(raw, link), source);
});

test("inline caption says a carousel has more at the source", () => {
  assert.equal(inlineCaption(raw, link, 4), `${source}\nЗдесь 1 из 4, остальное по ссылке`);
});

test("a failed download says why, escaped", () => {
  assert.equal(failedCaption(source, "video is <7> min"), `❌ Не получилось скачать: video is &lt;7&gt; min\n${source}`);
});

test("reads the file_id of an uploaded photo, video or silent video", () => {
  const item = { type: "video", file: "/tmp/a.mp4", width: 720, height: 1280, duration: 9 };
  assert.deepEqual(storedItem({ photo: [{ file_id: "small" }, { file_id: "big" }] }, { type: "photo" }), { type: "photo", fileId: "big", count: 1 });
  assert.deepEqual(storedItem({ video: { file_id: "v" } }, item, 3), { type: "video", fileId: "v", width: 720, height: 1280, duration: 9, count: 3 });
  assert.deepEqual(storedItem({ animation: { file_id: "g" } }, item), { type: "animation", fileId: "g", count: 1 });
});

test("the placeholder becomes the stored file, a video keeps its size", () => {
  const video = { type: "video", fileId: "v", width: 720, height: 1280, duration: 9 };
  assert.deepEqual(inputMedia(video, "c"), {
    type: "video", media: "v", caption: "c", parse_mode: "HTML", width: 720, height: 1280, duration: 9, supports_streaming: true,
  });
  assert.deepEqual(inputMedia({ type: "photo", fileId: "p" }, "c"), { type: "photo", media: "p", caption: "c", parse_mode: "HTML" });
});

test("a stored link is answered with the matching cached result", () => {
  assert.equal(cachedResult("s", { type: "photo", fileId: "p" }, "c").photo_file_id, "p");
  assert.equal(cachedResult("s", { type: "animation", fileId: "g" }, "c").gif_file_id, "g");
  const video = cachedResult("s", { type: "video", fileId: "v" }, "c");
  assert.equal(video.video_file_id, "v");
  assert.ok(video.title, "cached videos need a title");
});
