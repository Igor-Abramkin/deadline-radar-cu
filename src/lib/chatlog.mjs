import { Database } from "bun:sqlite";

// The group's recent messages, kept for chat summaries (see summary.mjs).
// The Bot API can't read a chat's history, so the bot can only summarize
// what it was sent while running and wrote down here.

const fullName = (user) => [user.first_name, user.last_name].filter(Boolean).join(" ");

// Checked in this order: an animation also carries `document`.
const MEDIA = [
  ["photo", "фото"],
  ["animation", "гифка"],
  ["video", "видео"],
  ["video_note", "кружок"],
  ["voice", "голосовое"],
  ["audio", "аудио"],
  ["location", "геопозиция"],
  ["contact", "контакт"],
];

// What a message carries besides text, in words: the summary is written from
// text alone, and "[фото]" still tells the model something was shown.
function attachment(msg) {
  if (msg.poll) return `опрос: ${msg.poll.question} (${msg.poll.options.map((o) => o.text).join(" / ")})`;
  if (msg.sticker) return `стикер ${msg.sticker.emoji ?? ""}`.trim();
  const media = MEDIA.find(([field]) => msg[field]);
  if (media) return media[1];
  return msg.document ? `файл ${msg.document.file_name ?? ""}`.trim() : null;
}

function forwardedFrom(origin) {
  if (!origin) return null;
  if (origin.type === "user") return fullName(origin.sender_user);
  if (origin.type === "hidden_user") return origin.sender_user_name;
  return (origin.chat ?? origin.sender_chat)?.title ?? null;
}

// A Telegram message as a row of the log, or null for what a summary has no
// use for: service messages, commands, other bots.
export function toEntry(msg) {
  const text = msg.text ?? msg.caption ?? "";
  if (text.startsWith("/")) return null;
  // Anonymous admins and linked channels post through a bot account too, but
  // as a chat; those are kept.
  if (msg.from?.is_bot && !msg.sender_chat) return null;
  const attached = attachment(msg);
  if (!text && !attached) return null;
  const forwarded = forwardedFrom(msg.forward_origin);
  const reply = msg.reply_to_message;
  return {
    id: msg.message_id,
    // In a group without topics the thread id only marks a chain of replies.
    threadId: msg.is_topic_message ? msg.message_thread_id : null,
    userId: msg.sender_chat?.id ?? msg.from?.id ?? null,
    name: msg.sender_chat?.title ?? fullName(msg.from ?? {}),
    text: [forwarded && `[переслано от: ${forwarded}]`, attached && `[${attached}]`, text].filter(Boolean).join(" "),
    // A message that isn't a reply still "replies" to the topic's first message.
    replyTo: reply && !reply.forum_topic_created ? reply.message_id : null,
    date: msg.date * 1000,
  };
}

// The topic name a message reveals. Bots can't list topics: a name comes with
// the topic being created or renamed (`current`), or from the first message of
// the topic, attached to every message in it, which keeps the original name.
export function topicOf(msg) {
  const named = msg.forum_topic_created ?? msg.forum_topic_edited;
  if (named?.name && msg.message_thread_id) return { threadId: msg.message_thread_id, name: named.name, current: true };
  const first = msg.reply_to_message?.forum_topic_created;
  if (first && msg.is_topic_message) return { threadId: msg.message_thread_id, name: first.name, current: false };
  return null;
}

const COLUMNS = "id, thread_id AS threadId, user_id AS userId, name, text, reply_to AS replyTo, date";

export function openLog(file) {
  const db = new Database(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      thread_id INTEGER,
      user_id INTEGER,
      name TEXT NOT NULL,
      text TEXT NOT NULL,
      reply_to INTEGER,
      date INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_date ON messages (date);
    CREATE TABLE IF NOT EXISTS topics (thread_id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS seen (user_id INTEGER PRIMARY KEY, date INTEGER NOT NULL);
  `);

  const insert = db.query("INSERT OR REPLACE INTO messages (id, thread_id, user_id, name, text, reply_to, date) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const newest = db.query(
    `SELECT ${COLUMNS} FROM (SELECT * FROM messages WHERE date > ? AND date <= ? ORDER BY date DESC, id DESC LIMIT ?) ORDER BY date, id`,
  );
  const count = db.query("SELECT COUNT(*) AS n FROM messages WHERE date > ? AND date <= ?");
  const renameTopic = db.query("INSERT OR REPLACE INTO topics (thread_id, name) VALUES (?, ?)");
  const nameTopic = db.query("INSERT OR IGNORE INTO topics (thread_id, name) VALUES (?, ?)");
  const allTopics = db.query("SELECT thread_id AS threadId, name FROM topics");
  const touch = db.query("INSERT INTO seen (user_id, date) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET date = max(date, excluded.date)");
  const seen = db.query("SELECT date FROM seen WHERE user_id = ?");
  const prune = db.query("DELETE FROM messages WHERE date < ?");

  return {
    // An edited message comes with its id and original date, so it replaces
    // the row it was.
    add: (m) => insert.run(m.id, m.threadId, m.userId, m.name, m.text, m.replyTo, m.date),
    // The newest `limit` messages after `from` up to `to`, oldest first, and
    // how many there are in that time in all.
    window({ from = 0, to = Number.MAX_SAFE_INTEGER, limit }) {
      return { messages: newest.all(from, to, limit), total: count.get(from, to).n };
    },
    setTopic: ({ threadId, name, current }) => (current ? renameTopic : nameTopic).run(threadId, name),
    topics: () => new Map(allTopics.all().map((t) => [t.threadId, t.name])),
    // When each member last wrote in the group: where "what did I miss" starts.
    touch: (userId, date) => touch.run(userId, date),
    lastSeen: (userId) => seen.get(userId)?.date ?? null,
    prune: (before) => prune.run(before).changes,
  };
}
