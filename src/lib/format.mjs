const TZ = process.env.TZ_DISPLAY || "Europe/Moscow";

const dateFmt = new Intl.DateTimeFormat("ru-RU", {
  timeZone: TZ,
  weekday: "short",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});

export const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const formatDate = (iso) => dateFmt.format(new Date(iso));

export function formatLeft(iso, now = Date.now()) {
  const hours = (Date.parse(iso) - now) / 3_600_000;
  if (hours < 1) return `через ${Math.max(1, Math.round(hours * 60))} мин`;
  if (hours < 48) return `через ${Math.round(hours)} ч`;
  return `через ${Math.round(hours / 24)} дн`;
}

export function formatTask(t, now) {
  return [
    `<b><a href="${t.url}">${escape(t.name)}</a></b>`,
    `${escape(t.course)}`,
    `⏰ ${formatDate(t.deadline)} · ${formatLeft(t.deadline, now)}`,
  ].join("\n");
}

export const formatList = (tasks, now) => tasks.map((t) => formatTask(t, now)).join("\n\n");
