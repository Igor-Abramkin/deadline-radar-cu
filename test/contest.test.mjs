import { test } from "node:test";
import assert from "node:assert/strict";
import { contestEvent, formatReminder, formatResult, timeLeft, winners } from "../src/lib/contest.mjs";

const H = 3_600_000;
const deadline = "2026-09-28T00:00:00+03:00";
const end = Date.parse(deadline);
const R = [72, 48, 24, 12, 3, 1];
const contest = (entries = []) => ({ title: "Опрос", url: "https://poll", deadline, entries });

test("first sight posts nothing for thresholds already passed", () => {
  const state = {};
  assert.equal(contestEvent(state, contest(), end - 30 * H, R), null);
  assert.deepEqual(state.sent, [72, 48]);
  assert.deepEqual(contestEvent(state, contest(), end - 24 * H, R), { type: "reminder", hours: 24 });
  assert.equal(contestEvent(state, contest(), end - 23 * H, R), null);
});

test("every threshold fires once, then the result once", () => {
  const state = {};
  contestEvent(state, contest(), end - 100 * H, R);
  const fired = [];
  for (let t = end - 100 * H; t <= end + 2 * H; t += 60_000) {
    const e = contestEvent(state, contest(), t, R);
    if (e) fired.push(e.type === "reminder" ? e.hours : e.type);
  }
  assert.deepEqual(fired, [72, 48, 24, 12, 3, 1, "finished"]);
});

test("after downtime only the tightest threshold is posted", () => {
  const state = {};
  contestEvent(state, contest(), end - 100 * H, R);
  assert.deepEqual(contestEvent(state, contest(), end - 2 * H, R), { type: "reminder", hours: 3 });
  assert.equal(contestEvent(state, contest(), end - 2.5 * H, R), null);
});

test("an extended deadline restarts the countdown without replaying", () => {
  const state = {};
  contestEvent(state, contest(), end - 100 * H, R);
  contestEvent(state, contest(), end - 70 * H, R);
  const later = { ...contest(), deadline: new Date(end + 48 * H).toISOString() };
  assert.equal(contestEvent(state, later, end - 70 * H, R), null);
  assert.deepEqual(state.sent, []);
  assert.deepEqual(contestEvent(state, later, end - 24 * H, R), { type: "reminder", hours: 72 });
});

test("winners handle ties and empty votes", () => {
  const a = { name: "A", votes: 3 };
  const b = { name: "B", votes: 5 };
  const c = { name: "C", votes: 5 };
  assert.deepEqual(winners([a, b]), [b]);
  assert.deepEqual(winners([a, b, c]), [b, c]);
  assert.deepEqual(winners([{ name: "A", votes: 0 }]), []);
});

test("messages", () => {
  assert.equal(timeLeft(72), "3 дня");
  assert.equal(timeLeft(48), "2 дня");
  assert.equal(timeLeft(24), "сутки");
  assert.equal(timeLeft(12), "12 часов");
  assert.equal(timeLeft(3), "3 часа");
  assert.equal(timeLeft(1), "час");
  const entries = [
    { name: "<Альфа>", votes: 1, author: { name: "Аня", username: "anya" } },
    { name: "Бета", votes: 2, author: { name: "Боря", username: null } },
  ];
  const reminder = formatReminder(contest(entries), 12);
  assert.match(reminder, /До конца — 12 часов\. Вариантов: 2, 3 голоса\./);
  assert.match(reminder, /1\. «Бета» · 2 голоса\n2\. «&lt;Альфа&gt;» · 1 голос/);
  assert.doesNotMatch(reminder, /@anya/);
  assert.match(formatResult(contest(entries)), /Победил вариант <b>«Бета»<\/b>: 2 голоса\.\nАвтор: Боря/);
  assert.match(formatResult(contest([])), /победителя нет/);
});
