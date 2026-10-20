import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { escape } from "./format.mjs";

// Bots can upload files up to 50 MB, photos up to 10 MB; an album holds 10.
export const MAX_BYTES = 50 * 1024 * 1024;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_ITEMS = 10;

// Only links to these sites are downloaded: a news article with an embedded
// clip stays a link.
const HOSTS = [
  "youtube.com", "youtu.be",
  "x.com", "twitter.com",
  "instagram.com",
  "threads.net", "threads.com",
  "tiktok.com",
  "vimeo.com",
  "twitch.tv",
  "reddit.com", "redd.it",
  "facebook.com", "fb.watch",
  "vk.com", "vkvideo.ru",
  "pinterest.com", "pin.it",
];

const isMediaHost = (url) => {
  try {
    const { protocol, hostname } = new URL(url);
    const host = hostname.toLowerCase();
    return /^https?:$/.test(protocol) && HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
};

// The first link to a media site in a message, typed out or hidden behind text.
// Offsets are in UTF-16 units, same as JS strings.
export function findMediaLink(text = "", entities = []) {
  for (const e of entities) {
    if (e.type !== "url" && e.type !== "text_link") continue;
    const raw = text.slice(e.offset, e.offset + e.length);
    const url = e.type === "text_link" ? e.url : /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    if (isMediaHost(url)) return { url, raw: e.type === "url" ? raw : null };
  }
  return null;
}

// The repost stands in for the deleted message: who sent it, what they wrote
// besides the link, and the link itself.
export function formatCaption({ name, text, link }) {
  const comment = (link.raw ? text.replace(link.raw, "") : text).trim();
  const lines = [`<b>${escape(name)}</b>${comment ? `: ${escape(comment)}` : ""}`, `<a href="${escape(link.url)}">Источник</a>`];
  const caption = lines.join("\n");
  // Captions are capped at 1024 characters; cut the comment, keep the link.
  if (caption.length <= 1024) return caption;
  return [`<b>${escape(name)}</b>: ${escape(comment.slice(0, 900))}…`, lines[1]].join("\n");
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { timeout: timeoutMs });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(out);
      const reason = err
        .split("\n")
        .filter((l) => /^ERROR:|\]\[error\]/.test(l))
        .at(-1)
        ?.replace(/^ERROR:\s*|^\[[^\]]+\]\[error\]\s*/, "");
      reject(new Error(reason || `${cmd} exited with ${code ?? "timeout"}`));
    });
  });
}

const PHOTO_EXT = /\.(jpe?g|png|webp)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov)$/i;

// What gallery-dl saved, in post order, as album items. Other files (gifs,
// zips) and anything over Telegram's limits are left out.
export function mediaItems(files) {
  return files
    .map((file) => {
      const size = statSync(file).size;
      if (PHOTO_EXT.test(file) && size <= MAX_PHOTO_BYTES) return { type: "photo", file };
      if (VIDEO_EXT.test(file) && size <= MAX_BYTES) return { type: "video", file };
      return null;
    })
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

// Instagram photos and carousels, read from yt-dlp's metadata: it gets them
// without a login, gallery-dl doesn't. A photo is the last (uncropped,
// full-size) thumbnail, a video in a carousel the best mp4 that has sound.
export function instagramSources(info) {
  const nodes = info._type === "playlist" ? info.entries ?? [] : [info];
  return nodes
    .map((node) => {
      const mp4 = (node.formats ?? [])
        .filter((f) => f.url && f.ext === "mp4" && f.vcodec !== "none" && f.acodec !== "none" && (f.height ?? 0) <= 1080)
        .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
      if (mp4) return { type: "video", url: mp4.url, ext: "mp4", width: mp4.width, height: mp4.height, duration: node.duration };
      if (node.formats?.length) return null;
      const photo = node.thumbnails?.at(-1)?.url;
      return photo ? { type: "photo", url: photo, ext: "jpg" } : null;
    })
    .filter(Boolean)
    .slice(0, MAX_ITEMS);
}

// Not every site reports sizes up front, so a video that comes out too big
// is fetched again a step lower: 1080p, 720p, 480p by the short side, so
// vertical reels aren't cut to 360p. --max-filesize stops a download early
// once the server says it's too big.
async function downloadVideo(ytdlp, infoFile, dir, common, timeoutMs) {
  for (const res of [1080, 720, 480]) {
    const out = await run(ytdlp, [
      "--load-info-json", infoFile,
      "-f", "bv*+ba/b",
      "-S", `vcodec:h264,res:${res},ext:mp4:m4a`,
      "--merge-output-format", "mp4",
      "--max-filesize", String(MAX_BYTES),
      "-o", path.join(dir, `${res}-%(id)s.%(ext)s`),
      "--print", "after_move:%()j",
      "--no-simulate",
      ...common,
    ], timeoutMs);
    const line = out.trim().split("\n").at(-1);
    const info = line ? JSON.parse(line) : null;
    if (!info?.filepath || !existsSync(info.filepath)) continue;
    if (statSync(info.filepath).size > MAX_BYTES) {
      rmSync(info.filepath, { force: true });
      continue;
    }
    return {
      type: "video",
      file: info.filepath,
      width: info.width ?? undefined,
      height: info.height ?? undefined,
      duration: info.duration ? Math.round(info.duration) : undefined,
    };
  }
  throw new Error("video too big");
}

async function fetchTo(file, url, proxy) {
  const res = await fetch(url, { proxy, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} → ${res.status}`);
  await Bun.write(file, res);
  return file;
}

// Downloads what's behind a link into a fresh temp dir and returns it as
// album items ({ type: "video" | "photo", file, width?, height?, duration? }).
// `cleanup` removes the dir.
//
// yt-dlp looks at the link first. A single video it downloads itself: H.264
// in mp4, which Telegram plays inline everywhere. Instagram photos and
// carousels come from its metadata. Everything else (photo tweets, Reddit
// galleries, TikTok slideshows) goes to gallery-dl.
export async function downloadMedia(url, { ytdlp = "yt-dlp", gallerydl = "gallery-dl", cookies, proxy, timeoutMs = 5 * 60_000 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "media-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const common = [
    "--no-warnings",
    // YouTube needs a JS runtime; the bot already runs on one.
    "--js-runtimes", "bun",
    ...(cookies && existsSync(cookies) ? ["--cookies", cookies] : []),
    ...(proxy ? ["--proxy", proxy] : []),
  ];
  try {
    const probe = await run(ytdlp, [url, "-J", "--no-playlist", "--ignore-no-formats-error", ...common], timeoutMs)
      .then((out) => JSON.parse(out))
      .catch((err) => (console.error("yt-dlp probe:", err.message), null));

    if (probe?.is_live) throw new Error("live stream");
    if (probe && probe._type !== "playlist" && probe.formats?.length) {
      // Reuse the probe instead of extracting the page a second time.
      const infoFile = path.join(dir, "info.json");
      writeFileSync(infoFile, JSON.stringify(probe));
      const item = await downloadVideo(ytdlp, infoFile, dir, common, timeoutMs);
      return { items: [item], cleanup };
    }

    if (probe?.extractor_key?.startsWith("Instagram")) {
      const sources = instagramSources(probe);
      if (!sources.length) throw new Error("nothing to download in this post");
      const items = [];
      for (const [i, { url: src, ext, ...rest }] of sources.entries()) {
        const file = await fetchTo(path.join(dir, `${i}.${ext}`), src, proxy);
        if (mediaItems([file]).length) items.push({ ...rest, file });
      }
      if (!items.length) throw new Error("post too big to upload");
      return { items, cleanup };
    }

    // gallery-dl prints each saved file on its own line, in post order.
    const out = await run(gallerydl, [
      url,
      "-D", dir,
      "--range", `1-${MAX_ITEMS}`,
      "--filesize-max", "50M",
      "--no-mtime",
      ...(cookies && existsSync(cookies) ? ["--cookies", cookies] : []),
      ...(proxy ? ["--proxy", proxy] : []),
    ], timeoutMs);
    const files = out.split("\n").map((l) => l.trim()).filter((l) => l.startsWith(dir) && existsSync(l));
    const items = mediaItems(files);
    if (!items.length) throw new Error("nothing to download");
    return { items, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// Extractors break as sites change, so the binary updates itself. Fails
// quietly where yt-dlp came from a package manager.
export const updateYtDlp = (ytdlp = "yt-dlp") =>
  run(ytdlp, ["-U"], 120_000).then(
    (out) => console.log("yt-dlp:", out.trim().split("\n").at(-1)),
    (err) => console.error("yt-dlp update failed:", err.message),
  );
