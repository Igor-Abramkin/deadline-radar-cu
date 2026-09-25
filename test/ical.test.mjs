import { test } from "node:test";
import assert from "node:assert/strict";
import ICAL from "ical.js";
import { deadlinesCalendar } from "../src/lib/ical.mjs";

const task = {
  id: 42,
  name: "ДЗ 2. Выбрать тему финального проекта, собрать доску; с двумя эстетиками",
  course: "Генеративный ИИ",
  activity: "Домашнее задание",
  url: "https://my.centraluniversity.ru/learn/courses/view/actual/1/themes/2/longreads/3",
  deadline: "2026-09-25T20:55:00+00:00",
};

test("the feed parses back with the deadline, escaped text and alarms", () => {
  const ics = deadlinesCalendar([task], Date.parse("2026-09-25T00:00:00Z"));
  for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, line);

  const cal = new ICAL.Component(ICAL.parse(ics));
  const [vevent] = cal.getAllSubcomponents("vevent");
  const event = new ICAL.Event(vevent);
  assert.equal(event.uid, "42@deadline-radar-cu");
  assert.equal(event.summary, `⏰ ${task.name} · ${task.course}`);
  assert.equal(event.startDate.toJSDate().toISOString(), "2026-09-25T20:25:00.000Z");
  assert.equal(event.endDate.toJSDate().toISOString(), "2026-09-25T20:55:00.000Z");
  assert.equal(event.description, `${task.course}\n${task.activity}\n${task.url}`);
  const alarms = vevent.getAllSubcomponents("valarm");
  assert.equal(alarms.length, 2);
  for (const alarm of alarms) assert.equal(alarm.getFirstProperty("trigger").getParameter("related"), "END");
});
