import { escape } from "./format.mjs";
import { formatCaption } from "./media.mjs";

// Pieces of inline mode ("@bot <link>" in any chat, see bot.mjs): the caption,
// the answer for a link already uploaded, and what the placeholder becomes.

// The message goes out from the user, so no name: what they typed besides
// the link, and the link. An inline message holds one photo or video, so for
// a carousel it says the rest is at the source.
export function inlineCaption(query, link, count = 1) {
  const caption = formatCaption({ name: null, text: query, link });
  const more = count > 1 ? `\nЗдесь 1 из ${count}, остальное по ссылке` : "";
  return caption.length + more.length <= 1024 ? caption + more : caption;
}

export const pendingCaption = (caption) => `⏳ Скачиваю…\n${caption}`;
export const failedCaption = (caption, reason) => `❌ Не получилось скачать: ${escape(reason)}\n${caption}`;

// What the upload of a downloaded item left on Telegram's servers. Telegram
// turns a silent mp4 into an animation, so the type comes from the message.
export function storedItem(msg, item, count = 1) {
  if (msg.photo) return { type: "photo", fileId: msg.photo.at(-1).file_id, count };
  if (msg.animation) return { type: "animation", fileId: msg.animation.file_id, count };
  const { width, height, duration } = item;
  return { type: "video", fileId: msg.video.file_id, width, height, duration, count };
}

// The placeholder's replacement, for editMessageMedia.
export function inputMedia(item, caption) {
  const media = { type: item.type, media: item.fileId, caption, parse_mode: "HTML" };
  if (item.type !== "video") return media;
  const { width, height, duration } = item;
  return { ...media, width, height, duration, supports_streaming: true };
}

// A link uploaded before is answered with the file itself, no placeholder.
export function cachedResult(id, item, caption) {
  const common = { id, caption, parse_mode: "HTML" };
  if (item.type === "photo") return { type: "photo", photo_file_id: item.fileId, ...common };
  if (item.type === "animation") return { type: "gif", gif_file_id: item.fileId, ...common };
  return { type: "video", video_file_id: item.fileId, title: "Видео", ...common };
}
