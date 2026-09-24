import { test } from "node:test";
import assert from "node:assert/strict";
import { guardCommand } from "../src/lib/guard.mjs";

const cfg = { chatId: "-100", threadId: "265", botUsername: "hxdesign_bot", groupCooldownMs: 3_600_000, privateCooldownMs: 30_000, ownerId: "42" };
const group = (text, threadId, now = 0) => ({ text, chatId: -100, chatType: "supergroup", threadId, userId: 1, now });
const dm = (text, userId, now = 0) => ({ text, chatId: userId, chatType: "private", userId, now });

test("group command from any topic runs and is removed", () => {
  assert.deepEqual(guardCommand(group("/deadlines", 265), new Map(), cfg), { command: "deadlines", remove: true, run: true });
  assert.deepEqual(guardCommand(group("/deadlines", 7), new Map(), cfg), { command: "deadlines", remove: true, run: true });
  assert.deepEqual(guardCommand(group("/help@hxdesign_bot", undefined), new Map(), cfg), { command: "help", remove: true, run: true });
});

test("group repeats within cooldown are removed and ignored, from any user", () => {
  const last = new Map();
  guardCommand(group("/deadlines", 265, 0), last, cfg);
  assert.deepEqual(guardCommand({ ...group("/deadlines", 7, 3_599_000), userId: 2 }, last, cfg), { command: "deadlines", remove: true, run: false });
  assert.equal(guardCommand(group("/deadlines", 7, 3_600_000), last, cfg).run, true);
});

test("cooldown is per command", () => {
  const last = new Map();
  guardCommand(group("/deadlines", 265, 0), last, cfg);
  assert.equal(guardCommand(group("/help", 265, 1000), last, cfg).run, true);
});

test("private cooldown is per user and shorter", () => {
  const last = new Map();
  guardCommand(dm("/deadlines", 1, 0), last, cfg);
  assert.deepEqual(guardCommand(dm("/deadlines", 1, 10_000), last, cfg), { command: "deadlines", remove: false, run: false });
  assert.equal(guardCommand(dm("/deadlines", 2, 10_000), last, cfg).run, true);
  assert.equal(guardCommand(dm("/deadlines", 1, 30_000), last, cfg).run, true);
});

test("session is removed in the group, even in the topic, and never runs there", () => {
  assert.deepEqual(guardCommand(group("/session abc", 265), new Map(), cfg), { command: "session", remove: true, run: false });
  assert.deepEqual(guardCommand(dm("/session abc", 42), new Map(), cfg), { command: "session", remove: false, run: true });
  assert.deepEqual(guardCommand(dm("/session abc", 1), new Map(), cfg), { command: "session", remove: false, run: false });
});

test("other bots' commands and plain text are ignored", () => {
  assert.equal(guardCommand(group("/deadlines@other_bot", 7), new Map(), cfg), null);
  assert.equal(guardCommand(group("/poll", 7), new Map(), cfg), null);
  assert.equal(guardCommand(group("привет", 7), new Map(), cfg), null);
});

test("owner has no cooldown and doesn't use up the group's", () => {
  const last = new Map();
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(guardCommand({ ...group("/deadlines", 7, i), userId: 42 }, last, cfg), { command: "deadlines", remove: true, run: true });
  }
  assert.equal(guardCommand(group("/deadlines", 7, 10), last, cfg).run, true);
  assert.equal(guardCommand({ ...dm("/deadlines", 42, 11) }, last, cfg).run, true);
  assert.equal(guardCommand({ ...dm("/deadlines", 42, 12) }, last, cfg).run, true);
});

test("chatid is owner-only", () => {
  assert.deepEqual(guardCommand(group("/chatid", 7), new Map(), cfg), { command: "chatid", remove: true, run: false });
  assert.deepEqual(guardCommand(dm("/chatid", 1), new Map(), cfg), { command: "chatid", remove: false, run: false });
  assert.deepEqual(guardCommand({ ...group("/chatid", 7), userId: 42 }, new Map(), cfg), { command: "chatid", remove: true, run: true });
});
