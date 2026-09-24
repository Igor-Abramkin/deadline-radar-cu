import { test } from "node:test";
import assert from "node:assert/strict";
import { diff } from "../src/lib/diff.mjs";

const H = 3_600_000;
const now = Date.parse("2026-09-24T00:00:00Z");
const task = (id, hours) => ({ id, name: `t${id}`, course: "c", url: "u", deadline: new Date(now + hours * H).toISOString() });
const R = [72, 24, 3];

test("bootstrap posts nothing and marks passed thresholds", () => {
  const state = { bootstrapped: false, tasks: {} };
  const e = diff(state, [task(1, 10), task(2, 100)], now, R);
  assert.equal(e.added.length + e.moved.length + e.reminders.size, 0);
  assert.deepEqual(state.tasks["1"].sent, [72, 24]);
  assert.deepEqual(state.tasks["2"].sent, []);
});

test("reminder fires once when a threshold is crossed", () => {
  const state = { bootstrapped: false, tasks: {} };
  diff(state, [task(1, 30)], now, R);
  const e = diff(state, [task(1, 30)], now + 7 * H, R);
  assert.deepEqual([...e.reminders.keys()], [24]);
  assert.equal(diff(state, [task(1, 30)], now + 8 * H, R).reminders.size, 0);
});

test("after downtime only the tightest threshold is posted", () => {
  const state = { bootstrapped: false, tasks: {} };
  diff(state, [task(1, 100)], now, R);
  const e = diff(state, [task(1, 100)], now + 98 * H, R);
  assert.deepEqual([...e.reminders.keys()], [3]);
});

test("new task after bootstrap is announced, moved deadline is reported", () => {
  const state = { bootstrapped: false, tasks: {} };
  diff(state, [task(1, 100)], now, R);
  const e = diff(state, [task(1, 150), task(2, 50)], now, R);
  assert.deepEqual(e.added.map((t) => t.id), [2]);
  assert.deepEqual(e.moved.map((m) => m.task.id), [1]);
});

test("tasks gone from LMS are forgotten", () => {
  const state = { bootstrapped: false, tasks: {} };
  diff(state, [task(1, 100)], now, R);
  diff(state, [], now, R);
  assert.deepEqual(state.tasks, {});
});
