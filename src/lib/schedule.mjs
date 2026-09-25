import ICAL from "ical.js";
import { escape } from "./format.mjs";

const TZ = process.env.TZ_DISPLAY || "Europe/Moscow";
const DAY = 86_400_000;

const dayKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
const shortDayFmt = new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, weekday: "short", day: "numeric", month: "long" });

// "2026-09-25" in the display time zone: what "today" means for the group.
export const dayKey = (ms) => dayKeyFmt.format(new Date(ms));
export const localTime = (ms) => timeFmt.format(new Date(ms));

// The timetable writes "Title, Kind, Room (Building)", and titles may carry
// their own commas inside parentheses: "Сбор гостей (Дизайн, холл), …".
export function splitSummary(summary) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of summary) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  parts.push(cur.trim());
  const [title, kind = "", ...place] = parts;
  return { title, kind, place: place.join(", ") };
}

function occurrence(event, uid, slot, start, end) {
  const url = String(event.description ?? "").match(/https?:\/\/\S+/)?.[0] ?? null;
  return { key: `${uid}/${new Date(slot).toISOString()}`, start, end, ...splitSummary(event.summary ?? ""), url };
}

const cancelled = (event) => String(event.component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED";

// Expands the calendar into single classes overlapping [from, to]. Each class
// is keyed by its series and original slot, so a moved class keeps its key.
//
// Yandex exports a moved class as an override whose RECURRENCE-ID names the
// slot it replaces. When the series itself was later shifted, some overrides
// still point at the old time and match no slot; those replace the series'
// class on the same day, as a series here never meets twice a day.
export function parseSchedule(ics, { from, to, organizer }) {
  const cal = new ICAL.Component(ICAL.parse(ics));
  for (const tz of cal.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(tz);

  const series = new Map();
  for (const vevent of cal.getAllSubcomponents("vevent")) {
    // Personal events live in the same calendar; only the timetable's go out.
    const org = String(vevent.getFirstPropertyValue("organizer") ?? "").toLowerCase();
    if (organizer && !org.includes(organizer.toLowerCase())) continue;
    const event = new ICAL.Event(vevent);
    if (!series.has(event.uid)) series.set(event.uid, { master: null, overrides: [] });
    const s = series.get(event.uid);
    if (event.isRecurrenceException()) s.overrides.push(event);
    else s.master = event;
  }

  const classes = [];
  const margin = 7 * DAY;
  for (const [uid, { master, overrides }] of series) {
    const slots = new Map();
    if (master && !cancelled(master)) {
      const length = master.endDate.toJSDate() - master.startDate.toJSDate();
      const it = master.iterator();
      for (let t; (t = it.next()); ) {
        const start = t.toJSDate().getTime();
        if (start > to + margin) break;
        if (start + length >= from - margin) slots.set(start, occurrence(master, uid, start, start, start + length));
      }
    }

    const replaced = new Set();
    const apply = (slot, ex) => {
      replaced.add(slot);
      if (cancelled(ex)) return slots.delete(slot);
      slots.set(slot, occurrence(ex, uid, slot, ex.startDate.toJSDate().getTime(), ex.endDate.toJSDate().getTime()));
    };
    const orphans = [];
    for (const ex of overrides) {
      const slot = ex.recurrenceId.toJSDate().getTime();
      if (slots.has(slot)) apply(slot, ex);
      else orphans.push({ ex, slot });
    }
    for (const { ex, slot } of orphans) {
      const sameDay = [...slots.keys()].find((s) => !replaced.has(s) && dayKey(s) === dayKey(slot));
      if (sameDay !== undefined) apply(sameDay, ex);
      // A slot outside the expanded range: the class stands on its own.
      else apply(slot, ex);
    }

    for (const c of slots.values()) if (c.end > from && c.start < to) classes.push(c);
  }
  return classes.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
}

const same = (a, b) =>
  a.start === b.start && a.end === b.end && a.title === b.title && a.kind === b.kind && a.place === b.place;

// Compares a fresh expansion with the last snapshot and returns what changed
// among classes in the next `windowMs`. `prev.until` is how far the snapshot
// reached: classes past it are new to the bot, not new in the timetable.
//
// If the timetable recreates a series, every class gets a new key; a removed
// and an added class with the same title are then paired up, and dropped when
// nothing else differs.
export function diffSchedule(prev, next, now, windowMs) {
  const soon = (c) => c.end > now && c.start < now + windowMs;
  const current = new Map(next.map((c) => [c.key, c]));
  const changes = [];
  const added = [];
  const removed = [];

  for (const c of next) {
    const p = prev.classes[c.key];
    if (!p) {
      if (c.start < prev.until) added.push(c);
    } else if (!same(p, c)) {
      changes.push({ before: p, after: c });
    }
  }
  for (const [key, p] of Object.entries(prev.classes)) if (!current.has(key) && p.end > now) removed.push(p);

  for (const r of removed) {
    const candidates = added.filter((a) => a.title === r.title && a.kind === r.kind);
    if (!candidates.length) {
      changes.push({ before: r, after: null });
      continue;
    }
    const a = candidates.reduce((x, y) => (Math.abs(y.start - r.start) < Math.abs(x.start - r.start) ? y : x));
    added.splice(added.indexOf(a), 1);
    if (!same(r, a)) changes.push({ before: r, after: a });
  }
  for (const a of added) changes.push({ before: null, after: a });

  return changes
    .filter(({ before, after }) => (before && soon(before)) || (after && soon(after)))
    .map((c) => ({ ...c, type: changeType(c) }))
    .sort((x, y) => (x.after ?? x.before).start - (y.after ?? y.before).start);
}

function changeType({ before, after }) {
  if (!before) return "added";
  if (!after) return "removed";
  if (before.start !== after.start || before.end !== after.end) return "moved";
  return "changed";
}

const span = (c) => `${localTime(c.start)}–${localTime(c.end)}`;
const when = (c) => `${shortDayFmt.format(new Date(c.start))}, ${span(c)}`;
const heading = (c) => `<b>${escape(c.title)}</b>${c.kind ? ` · ${escape(c.kind)}` : ""}`;

function classLine(c) {
  const details = [c.kind, c.place].filter(Boolean).map(escape);
  if (c.url) details.push(`<a href="${escape(c.url)}">Толк</a>`);
  return [`<b>${span(c)}</b> · ${escape(c.title)}`, details.join(" · ")].filter(Boolean).join("\n");
}

export function formatDay(classes, day) {
  const title = `📚 <b>Сегодня, ${dayFmt.format(new Date(day))}</b>`;
  return `${title}\n\n${classes.length ? classes.map(classLine).join("\n\n") : "Пар нет 🎉"}`;
}

function formatChange({ type, before, after }) {
  const place = (c) => (c.place ? `📍 ${escape(c.place)}` : null);
  const placeMove = () =>
    before.place !== after.place ? `📍 ${escape(before.place || "—")} → ${escape(after.place || "—")}` : place(after);
  let lines;
  switch (type) {
    case "added":
      lines = [`🆕 Новая пара: ${heading(after)}`, when(after), place(after)];
      break;
    case "removed":
      lines = [`❌ Отменили: ${heading(before)}`, `<s>${when(before)}</s>`];
      break;
    case "moved":
      lines = [`🔁 Перенесли: ${heading(after)}`, `было: ${when(before)}`, `стало: ${when(after)}`, placeMove()];
      break;
    default:
      lines = [
        before.place !== after.place ? `📍 Другая аудитория: ${heading(after)}` : `✏️ Изменили: ${heading(after)}`,
        when(after),
        placeMove(),
      ];
  }
  return lines.filter(Boolean).join("\n");
}

export const formatChanges = (changes) =>
  `<b>Изменения в расписании</b>\n\n${changes.map(formatChange).join("\n\n")}`;
