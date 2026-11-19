import { test } from "node:test";
import assert from "node:assert/strict";
import { openLog, toEntry, topicOf } from "../src/lib/chatlog.mjs";

const anya = { id: 1, first_name: "Аня", last_name: "Иванова" };
const topicStart = { message_id: 7, forum_topic_created: { name: "Учёба" } };
const base = { message_id: 100, date: 1_000, from: anya, chat: { id: -100123 } };

test("a text message becomes a row", () => {
  assert.deepEqual(toEntry({ ...base, text: "привет" }), {
    id: 100,
    threadId: null,
    userId: 1,
    name: "Аня Иванова",
    text: "привет",
    replyTo: null,
    date: 1_000_000,
  });
});

test("the topic comes from a topic message, a reply from a real reply only", () => {
  const inTopic = { ...base, text: "а", is_topic_message: true, message_thread_id: 7, reply_to_message: topicStart };
  assert.equal(toEntry(inTopic).threadId, 7);
  assert.equal(toEntry(inTopic).replyTo, null);
  assert.equal(toEntry({ ...inTopic, reply_to_message: { message_id: 90 } }).replyTo, 90);
  // In a group without topics the thread id is just a chain of replies.
  assert.equal(toEntry({ ...base, text: "а", message_thread_id: 90, reply_to_message: { message_id: 90 } }).threadId, null);
});

test("attachments and forwards are described in words", () => {
  assert.equal(toEntry({ ...base, photo: [{}], caption: "конспект" }).text, "[фото] конспект");
  assert.equal(toEntry({ ...base, voice: {} }).text, "[голосовое]");
  assert.equal(toEntry({ ...base, animation: {}, document: { file_name: "a.mp4" } }).text, "[гифка]");
  assert.equal(toEntry({ ...base, document: { file_name: "лекция.pdf" } }).text, "[файл лекция.pdf]");
  assert.equal(
    toEntry({ ...base, poll: { question: "Когда?", options: [{ text: "вт" }, { text: "ср" }] } }).text,
    "[опрос: Когда? (вт / ср)]",
  );
  assert.equal(
    toEntry({ ...base, text: "Пары отменены", forward_origin: { type: "channel", chat: { title: "Деканат" } } }).text,
    "[переслано от: Деканат] Пары отменены",
  );
});

test("commands, other bots and service messages are skipped", () => {
  assert.equal(toEntry({ ...base, text: "/deadlines" }), null);
  assert.equal(toEntry({ ...base, text: "hi", from: { id: 5, is_bot: true, first_name: "Bot" } }), null);
  assert.equal(toEntry({ ...base, new_chat_members: [anya] }), null);
  assert.equal(toEntry({ ...base, pinned_message: { message_id: 1 } }), null);
});

test("an anonymous admin posts under the group's name", () => {
  const entry = toEntry({ ...base, text: "объявление", from: { id: 1087968824, is_bot: true, first_name: "Group" }, sender_chat: { id: -100123, title: "ИТ-25" } });
  assert.equal(entry.name, "ИТ-25");
  assert.equal(entry.userId, -100123);
});

test("topic names: created and renamed are current, the first message's is not", () => {
  assert.deepEqual(topicOf({ message_thread_id: 7, forum_topic_created: { name: "Учёба" } }), { threadId: 7, name: "Учёба", current: true });
  assert.deepEqual(topicOf({ message_thread_id: 7, forum_topic_edited: { name: "Матан" } }), { threadId: 7, name: "Матан", current: true });
  assert.equal(topicOf({ message_thread_id: 7, forum_topic_edited: { icon_custom_emoji_id: "1" } }), null);
  assert.deepEqual(topicOf({ is_topic_message: true, message_thread_id: 7, reply_to_message: topicStart }), { threadId: 7, name: "Учёба", current: false });
  assert.equal(topicOf({ text: "привет" }), null);
});

const row = (id, date, extra = {}) => ({ id, threadId: null, userId: 1, name: "Аня", text: `m${id}`, replyTo: null, date, ...extra });

test("window returns the newest messages in order, and the total", () => {
  const log = openLog(":memory:");
  for (let i = 1; i <= 5; i++) log.add(row(i, i * 10));
  assert.deepEqual(log.window({ limit: 10 }).messages.map((m) => m.id), [1, 2, 3, 4, 5]);
  const cut = log.window({ limit: 2 });
  assert.deepEqual(cut.messages.map((m) => m.id), [4, 5]);
  assert.equal(cut.total, 5);
  // After `from`, up to and including `to`.
  assert.deepEqual(log.window({ from: 20, to: 40, limit: 10 }).messages.map((m) => m.id), [3, 4]);
  assert.equal(log.window({ from: 20, to: 40, limit: 10 }).total, 2);
});

test("an edit replaces the message, prune drops the old ones", () => {
  const log = openLog(":memory:");
  log.add(row(1, 10));
  log.add(row(2, 20));
  log.add(row(1, 10, { text: "исправлено" }));
  assert.deepEqual(log.window({ limit: 10 }).messages.map((m) => m.text), ["исправлено", "m2"]);
  assert.equal(log.prune(15), 1);
  assert.deepEqual(log.window({ limit: 10 }).messages.map((m) => m.id), [2]);
});

test("a rename wins over the name seen on a message, whatever the order", () => {
  const log = openLog(":memory:");
  log.setTopic({ threadId: 7, name: "Учёба", current: false });
  log.setTopic({ threadId: 7, name: "Матан", current: true });
  log.setTopic({ threadId: 7, name: "Учёба", current: false });
  assert.equal(log.topics().get(7), "Матан");
});

test("last seen keeps the latest date", () => {
  const log = openLog(":memory:");
  assert.equal(log.lastSeen(1), null);
  log.touch(1, 50);
  log.touch(1, 30);
  assert.equal(log.lastSeen(1), 50);
});
