import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { escape } from "./format.mjs";

// Bots can upload files up to 50 MB.
export const MAX_BYTES = 50 * 1024 * 1024;

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

const isVideoHost = (url) => {
  try {
    const { protocol, hostname } = new URL(url);
    const host = hostname.toLowerCase();
    return /^https?:$/.test(protocol) && HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
};

// The first link to a video site in a message, typed out or hidden behind text.
// Offsets are in UTF-16 units, same as JS strings.
export function findVideoLink(text = "", entities = []) {
  for (const e of entities) {
    if (e.type !== "url" && e.type !== "text_link") continue;
    const raw = text.slice(e.offset, e.offset + e.length);
    const url = e.type === "text_link" ? e.url : /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    if (isVideoHost(url)) return { url, raw: e.type === "url" ? raw : null };
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
      const reason = err.split("\n").filter((l) => l.startsWith("ERROR:")).at(-1)?.replace(/^ERROR:\s*/, "");
      reject(new Error(reason || `${cmd} exited with ${code ?? "timeout"}`));
    });
  });
}

// Downloads the video at `url` into a fresh temp dir with yt-dlp. Telegram
// plays H.264 in mp4 inline on every client, so that's preferred, at up to
// 720p to fit the upload limit. `cleanup` removes the dir.
export async function downloadVideo(url, { ytdlp = "yt-dlp", cookies, timeoutMs = 5 * 60_000 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "video-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const args = [
      url,
      "--no-playlist",
      "--no-warnings",
      "--match-filter", "!is_live",
      "-f", "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
      "-S", "vcodec:h264,ext:mp4:m4a",
      "--merge-output-format", "mp4",
      "--max-filesize", String(MAX_BYTES),
      "-o", path.join(dir, "%(id)s.%(ext)s"),
      "--print", "after_move:%()j",
      "--no-simulate",
      // YouTube needs a JS runtime; the bot already runs on one.
      "--js-runtimes", "bun",
      ...(cookies && existsSync(cookies) ? ["--cookies", cookies] : []),
    ];
    const out = await run(ytdlp, args, timeoutMs);
    const line = out.trim().split("\n").at(-1);
    // --max-filesize and --match-filter skip the video without an error.
    if (!line) throw new Error("video skipped: live or too big");
    const info = JSON.parse(line);
    if (!info.filepath || !existsSync(info.filepath)) throw new Error("yt-dlp printed no file");
    if (statSync(info.filepath).size > MAX_BYTES) throw new Error("video too big");
    return {
      file: info.filepath,
      width: info.width ?? undefined,
      height: info.height ?? undefined,
      duration: info.duration ? Math.round(info.duration) : undefined,
      cleanup,
    };
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
