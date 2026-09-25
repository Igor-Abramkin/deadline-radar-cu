import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSchedule, formatChanges, formatDay, parseSchedule, splitSummary } from "../src/lib/schedule.mjs";

const H = 3_600_000;
const DAY = 24 * H;
const TIMETABLE = "timetable@centraluniversity.ru";

const vevent = (props) => ["BEGIN:VEVENT", ...props, "END:VEVENT"];
const calendar = (...events) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flat(), "END:VCALENDAR"].join("\r\n");
const organizer = `ORGANIZER;CN="ЦУ Расписание":mailto:${TIMETABLE}`;

// Weekly Saturday lecture at 11:30 MSK, as Yandex exports it.
const series = [
  "UID:lecture",
  "DTSTART:20260912T083000Z",
  "DTEND:20260912T095000Z",
  "SUMMARY:Основы дизайна\\, Лекция\\, S202 (ЦТ)",
  "DESCRIPTION:https://centraluniversity.ktalk.ru/abc",
  "RRULE:FREQ=WEEKLY;BYDAY=SA;UNTIL=20261220T093000Z;INTERVAL=1",
  organizer,
];
const from = Date.parse("2026-09-12T00:00:00+03:00");
const to = from + 21 * DAY;
const parse = (...events) => parseSchedule(calendar(vevent(series), ...events), { from, to, organizer: TIMETABLE });

test("summary splits into title, kind and place, keeping commas in parentheses", () => {
  assert.deepEqual(splitSummary("Сбор гостей (Дизайн, холл), Внутреннее мероприятие, B702 + B704 (Дукат)"), {
    title: "Сбор гостей (Дизайн, холл)",
    kind: "Внутреннее мероприятие",
    place: "B702 + B704 (Дукат)",
  });
  assert.deepEqual(splitSummary("Нетворкинг, Внутреннее мероприятие"), {
    title: "Нетворкинг",
    kind: "Внутреннее мероприятие",
    place: "",
  });
});

test("a weekly series expands into classes with the call link", () => {
  const classes = parse();
  assert.equal(classes.length, 3);
  assert.deepEqual(
    classes.map((c) => new Date(c.start).toISOString()),
    ["2026-09-12T08:30:00.000Z", "2026-09-19T08:30:00.000Z", "2026-09-26T08:30:00.000Z"],
  );
  assert.equal(classes[0].place, "S202 (ЦТ)");
  assert.equal(classes[0].url, "https://centraluniversity.ktalk.ru/abc");
});

test("an override replaces its slot and keeps the slot's key", () => {
  const plain = parse();
  const moved = parse(
    vevent([
      "UID:lecture",
      "RECURRENCE-ID:20260919T083000Z",
      "DTSTART:20260919T100000Z",
      "DTEND:20260919T112000Z",
      "SUMMARY:Основы дизайна\\, Лекция\\, Онлайн",
      organizer,
    ]),
  );
  assert.equal(moved.length, 3);
  assert.equal(moved[1].key, plain[1].key);
  assert.equal(new Date(moved[1].start).toISOString(), "2026-09-19T10:00:00.000Z");
  assert.equal(moved[1].place, "Онлайн");
});

test("an override pointing at a stale slot replaces the class on its day", () => {
  const classes = parse(
    vevent([
      "UID:lecture",
      "RECURRENCE-ID:20260926T070000Z",
      "DTSTART:20260926T083000Z",
      "DTEND:20260926T095000Z",
      "SUMMARY:Основы дизайна\\, Лекция\\, Онлайн",
      organizer,
    ]),
  );
  assert.equal(classes.length, 3);
  assert.equal(classes[2].place, "Онлайн");
});

test("cancelled occurrences and personal events are left out", () => {
  const classes = parse(
    vevent(["UID:lecture", "RECURRENCE-ID:20260919T083000Z", "DTSTART:20260919T083000Z", "DTEND:20260919T095000Z", "STATUS:CANCELLED", "SUMMARY:x", organizer]),
    vevent(["UID:mine", "DTSTART;TZID=Europe/Moscow:20260913T100000", "DTEND;TZID=Europe/Moscow:20260913T120000", "SUMMARY:Личное", "ORGANIZER;CN=me:mailto:me@edu.centraluniversity.ru"]),
  );
  assert.deepEqual(
    classes.map((c) => new Date(c.start).toISOString()),
    ["2026-09-12T08:30:00.000Z", "2026-09-26T08:30:00.000Z"],
  );
});

const cls = (key, startIso, extra = {}) => {
  const start = Date.parse(startIso);
  return { key, start, end: start + 80 * 60_000, title: "Генеративный ИИ", kind: "Лекция", place: "S308 (ЦТ)", url: null, ...extra };
};
const now = Date.parse("2026-09-25T12:00:00+03:00");
const snapshot = (...classes) => ({ classes: Object.fromEntries(classes.map((c) => [c.key, c])), until: now + 60 * DAY });
const WEEK = 7 * DAY;

test("a moved class and a room change are reported", () => {
  const a = cls("s/1", "2026-09-26T16:00:00+03:00");
  const b = cls("s/2", "2026-09-27T16:00:00+03:00");
  const changes = diffSchedule(snapshot(a, b), [{ ...a, start: a.start + H, end: a.end + H }, { ...b, place: "Онлайн" }], now, WEEK);
  assert.deepEqual(changes.map((c) => c.type), ["moved", "changed"]);
  const text = formatChanges(changes);
  assert.match(text, /Перенесли/);
  assert.match(text, /S308 \(ЦТ\) → Онлайн/);
});

test("changes beyond the window and classes already over are ignored", () => {
  const far = cls("s/1", "2026-10-20T16:00:00+03:00");
  const past = cls("s/2", "2026-09-24T16:00:00+03:00");
  const changes = diffSchedule(snapshot(far, past), [{ ...far, place: "Онлайн" }], now, WEEK);
  assert.deepEqual(changes, []);
});

test("a class gone from the calendar is cancelled; one within reach is new", () => {
  const a = cls("s/1", "2026-09-26T16:00:00+03:00");
  const b = cls("n/1", "2026-09-28T19:00:00+03:00", { title: "Гибкие навыки" });
  const changes = diffSchedule(snapshot(a), [b], now, WEEK);
  assert.deepEqual(changes.map((c) => c.type), ["removed", "added"]);
});

test("classes entering the snapshot's horizon are not new", () => {
  const b = cls("n/1", "2026-09-28T19:00:00+03:00");
  assert.deepEqual(diffSchedule({ classes: {}, until: now }, [b], now, WEEK), []);
});

test("a recreated series with the same classes posts nothing", () => {
  const a = cls("old/1", "2026-09-26T16:00:00+03:00");
  assert.deepEqual(diffSchedule(snapshot(a), [{ ...a, key: "new/1" }], now, WEEK), []);
  const changes = diffSchedule(snapshot(a), [{ ...a, key: "new/1", place: "Онлайн" }], now, WEEK);
  assert.deepEqual(changes.map((c) => c.type), ["changed"]);
});

test("the day post lists classes, or says there are none", () => {
  const day = Date.parse("2026-09-26T09:00:00+03:00");
  const text = formatDay([cls("s/1", "2026-09-26T16:00:00+03:00", { url: "https://k.talk/x" })], day);
  assert.match(text, /Сегодня, суббота, 26 сентября/);
  assert.match(text, /16:00–17:20/);
  assert.match(text, /Лекция · S308 \(ЦТ\) · <a href="https:\/\/k.talk\/x">Толк<\/a>/);
  assert.match(formatDay([], day), /Пар нет/);
});
