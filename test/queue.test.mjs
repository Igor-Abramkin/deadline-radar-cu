import { test } from "node:test";
import assert from "node:assert/strict";
import { queue } from "../src/lib/queue.mjs";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("runs at most two jobs at a time, in order, past failures", async () => {
  const enqueue = queue(2);
  let running = 0;
  let peak = 0;
  const started = [];
  const done = [];
  for (let i = 0; i < 5; i++) {
    enqueue(async () => {
      started.push(i);
      peak = Math.max(peak, ++running);
      await tick();
      running--;
      done.push(i);
      if (i === 1) throw new Error("boom");
    });
  }
  while (done.length < 5) await tick();
  assert.equal(peak, 2);
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
});
