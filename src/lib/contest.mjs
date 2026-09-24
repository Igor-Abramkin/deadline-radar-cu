import { escape } from "./format.mjs";

// Decides what to post about a contest: a countdown reminder or the final
// result. Mutates `state` (last seen deadline, thresholds already posted,
// whether the result is out) so the caller only has to save it.
export function contestEvent(state, contest, now, remindHours) {
  const deadline = Date.parse(contest.deadline);
  const hoursLeft = (deadline - now) / 3_600_000;
  const passed = remindHours.filter((h) => hoursLeft <= h);

  // First sight or a moved deadline: thresholds already behind us count as
  // sent, so a restart or an extension doesn't replay old countdown posts.
  if (state.deadline !== contest.deadline) {
    Object.assign(state, { deadline: contest.deadline, sent: passed, finished: false });
  }
  if (hoursLeft <= 0) {
    if (state.finished) return null;
    state.finished = true;
    return { type: "finished" };
  }
  const due = passed.filter((h) => !state.sent.includes(h));
  if (!due.length) return null;
  state.sent.push(...due);
  // After downtime several thresholds may be due at once: only the tightest matters.
  return { type: "reminder", hours: Math.min(...due) };
}

export const standings = (entries) => [...entries].sort((a, b) => b.votes - a.votes);

export function winners(entries) {
  const top = standings(entries);
  if (!top.length || top[0].votes === 0) return [];
  return top.filter((e) => e.votes === top[0].votes);
}

export function plural(n, [one, few, many]) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

const votes = (n) => plural(n, ["голос", "голоса", "голосов"]);

export function timeLeft(hours) {
  if (hours === 1) return "час";
  if (hours === 24) return "сутки";
  if (hours % 24 === 0) return plural(hours / 24, ["день", "дня", "дней"]);
  return plural(hours, ["час", "часа", "часов"]);
}

// Only the result mentions authors by @username: a mention pings, and
// countdown posts would ping the same people six times.
const author = (e) => escape(e.author?.username ? `@${e.author.username}` : (e.author?.name ?? ""));
const line = (e, i) => `${i + 1}. «${escape(e.name)}» · ${votes(e.votes)}`;

export function formatReminder(contest, hours) {
  const top = standings(contest.entries).filter((e) => e.votes).slice(0, 3);
  const total = contest.entries.reduce((sum, e) => sum + e.votes, 0);
  return [
    `🗳 <b>${escape(contest.title)}</b>`,
    "",
    `До конца — ${timeLeft(hours)}. Вариантов: ${contest.entries.length}, ${votes(total)}.`,
    ...(top.length ? ["", "<b>Сейчас лидируют</b>", ...top.map(line)] : []),
    "",
    `<a href="${contest.url}">Проголосовать</a>`,
  ].join("\n");
}

export function formatResult(contest) {
  const won = winners(contest.entries);
  const head = [`🏆 <b>${escape(contest.title)}</b>`, ""];
  if (!won.length) return [...head, "Голосование закончилось без голосов, победителя нет."].join("\n");
  const rest = standings(contest.entries)
    .filter((e) => e.votes && !won.includes(e))
    .slice(0, 3);
  const body =
    won.length === 1
      ? [
          `Голосование закончилось. Победил вариант <b>«${escape(won[0].name)}»</b>: ${votes(won[0].votes)}.`,
          won[0].author ? `Автор: ${author(won[0])}` : "",
        ]
      : [
          `Голосование закончилось ничьёй, у каждого ${votes(won[0].votes)}:`,
          ...won.map((e) => `• <b>«${escape(e.name)}»</b>${e.author ? ` · ${author(e)}` : ""}`),
        ];
  const others = rest.length ? ["", "Дальше:", ...rest.map((e, i) => line(e, i + won.length))] : [];
  return [...head, ...body.filter(Boolean), ...others, "", `<a href="${contest.url}">Все варианты</a>`].join("\n");
}
