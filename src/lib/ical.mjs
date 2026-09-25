// Renders the deadlines as an iCalendar feed people can subscribe to.

const CRLF = "\r\n";

const escapeText = (s) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");

const utc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// RFC 5545 caps lines at 75 octets; continuations start with a space. Cyrillic
// is two bytes per letter, so count bytes and never split a character.
function fold(line) {
  const out = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > 75) {
      out.push(cur);
      cur = " ";
      bytes = 1;
    }
    cur += ch;
    bytes += size;
  }
  out.push(cur);
  return out.join(CRLF);
}

// A deadline is a moment, not a slot, so each event starts and ends at it,
// the way Moodle exports due dates. Clients that honour alarms in subscribed
// calendars (Apple, Outlook) remind a day and three hours ahead.
export function deadlinesCalendar(tasks, now = Date.now()) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//deadline-radar-cu//RU",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Дедлайны ЦУ",
    "X-WR-TIMEZONE:Europe/Moscow",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  for (const t of tasks) {
    const at = utc(Date.parse(t.deadline));
    lines.push(
      "BEGIN:VEVENT",
      `UID:${t.id}@deadline-radar-cu`,
      `DTSTAMP:${utc(now)}`,
      `DTSTART:${at}`,
      `DTEND:${at}`,
      `SUMMARY:${escapeText(`⏰ ${t.name} · ${t.course}`)}`,
      `DESCRIPTION:${escapeText([t.course, t.activity, t.url].filter(Boolean).join("\n"))}`,
      `URL:${t.url}`,
      "TRANSP:TRANSPARENT",
    );
    for (const trigger of ["-P1D", "-PT3H"]) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(t.name)}`, `TRIGGER:${trigger}`, "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join(CRLF) + CRLF;
}
