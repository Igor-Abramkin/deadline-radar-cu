import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { Bot, InputFile } from "grammy";
import { SessionExpiredError, getMe, getTasks, setCookie } from "./lib/lms.mjs";
import { loadState, saveState } from "./lib/store.mjs";
import { diff } from "./lib/diff.mjs";
import { guardCommand } from "./lib/guard.mjs";
import { escape, formatDate, formatList, formatTask, formatTime } from "./lib/format.mjs";
import { contestEvent, formatReminder, formatResult, winners } from "./lib/contest.mjs";
import { screenshot } from "./lib/screenshot.mjs";
import { deadlinesCalendar } from "./lib/ical.mjs";
import { subscribePage } from "./lib/page.mjs";
import { dayKey, diffSchedule, formatChanges, formatDay, localTime, parseSchedule } from "./lib/schedule.mjs";

const { BOT_TOKEN, CHAT_ID, OWNER_ID, THREAD_ID, SCHEDULE_ICS_URL, SCHEDULE_THREAD_ID } = process.env;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set in .env");

const REMIND_HOURS = (process.env.REMIND_HOURS || "72,24,3").split(",").map(Number);
const POLL_MINUTES = Number(process.env.POLL_MINUTES || 30);
const LIST_DAYS = Number(process.env.LIST_DAYS || 14);
const GROUP_COOLDOWN_SEC = Number(process.env.GROUP_COOLDOWN_SEC || 3600);
const PRIVATE_COOLDOWN_SEC = Number(process.env.PRIVATE_COOLDOWN_SEC || 30);
const EXCLUDE = process.env.EXCLUDE_COURSES ? new RegExp(process.env.EXCLUDE_COURSES, "i") : null;
const DATA_DIR = process.env.DATA_DIR || "data";
const CONTEST_URL = process.env.CONTEST_URL;
const CONTEST_REMIND_HOURS = (process.env.CONTEST_REMIND_HOURS || "72,48,24,12,3,1").split(",").map(Number);
const PUBLIC_URL = process.env.PUBLIC_URL?.replace(/\/+$/, "");
const FEED_URL = PUBLIC_URL && `${PUBLIC_URL}/deadlines.ics`;
const SCHEDULE_TIME = process.env.SCHEDULE_TIME || "09:00";
const SCHEDULE_DAYS = Number(process.env.SCHEDULE_DAYS || 7);
const SCHEDULE_POLL_MINUTES = Number(process.env.SCHEDULE_POLL_MINUTES || 15);
const SCHEDULE_ORGANIZER = process.env.SCHEDULE_ORGANIZER ?? "timetable@centraluniversity.ru";

const bot = new Bot(BOT_TOKEN);

// In the forum group every outgoing message goes to the deadlines topic, even
// a reply to a command typed in another topic: ctx.reply would otherwise answer
// in whatever topic the command came from. Only the schedule posts, addressed
// to their own topic explicitly, go elsewhere.
if (CHAT_ID && THREAD_ID) {
  bot.api.config.use((prev, method, payload, signal) => {
    const toSchedule = SCHEDULE_THREAD_ID && payload?.message_thread_id === Number(SCHEDULE_THREAD_ID);
    if (method.startsWith("send") && String(payload?.chat_id) === CHAT_ID && !toSchedule) {
      payload = { ...payload, message_thread_id: Number(THREAD_ID) };
      delete payload.reply_parameters;
    }
    return prev(method, payload, signal);
  });
}

const send = (chatId, text) =>
  bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });

async function fetchAllTasks() {
  const tasks = await getTasks();
  return EXCLUDE ? tasks.filter((t) => !EXCLUDE.test(t.course)) : tasks;
}

const upcoming = (tasks, now = Date.now()) => tasks.filter((t) => Date.parse(t.deadline) > now);
const fetchTasks = async () => upcoming(await fetchAllTasks());

// The group summary is edited on every poll, so it says when it was last true.
function renderList(tasks, now, live = false) {
  const soon = tasks.filter((t) => Date.parse(t.deadline) <= now + LIST_DAYS * 86_400_000);
  const text = soon.length
    ? `<b>Дедлайны на ${LIST_DAYS} дней</b>\n\n${formatList(soon, now)}`
    : `На ближайшие ${LIST_DAYS} дней дедлайнов нет 🎉`;
  return live ? `${text}\n\n<i>Обновлено в ${formatTime(now)}</i>` : text;
}

function writeAtomic(file, text) {
  writeFileSync(file + ".tmp", text);
  renameSync(file + ".tmp", file);
}

function reminderTitle(hours) {
  if (hours >= 48) return `📅 Через ${Math.round(hours / 24)} дня дедлайн`;
  if (hours >= 24) return "⚠️ Дедлайн завтра";
  return `🔥 Дедлайн через ${hours} ч`;
}

async function tick() {
  const state = loadState();
  let all;
  try {
    all = await fetchAllTasks();
  } catch (err) {
    if (err instanceof SessionExpiredError && !state.sessionAlerted) {
      await send(
        OWNER_ID || CHAT_ID,
        "🔑 Сессия LMS истекла. Запусти <code>bun run login</code> и пришли мне в личку команду, которую он выведет.",
      );
      state.sessionAlerted = true;
      saveState(state);
    }
    throw err;
  }
  state.sessionAlerted = false;
  if (PUBLIC_URL) writeAtomic(FEED_FILE, deadlinesCalendar(all));
  const tasks = upcoming(all);
  // Without a target chat, only keep the LMS session warm: bootstrapping now
  // would mark reminders as sent that nobody ever saw.
  if (!CHAT_ID) return saveState(state);

  const now = Date.now();
  const { added, moved, reminders } = diff(state, tasks, now, REMIND_HOURS);
  const messages = [];

  if (added.length) messages.push(`🆕 <b>Новые задания</b>\n\n${formatList(added, now)}`);
  for (const { task, from } of moved) {
    messages.push(`🔁 <b>Дедлайн перенесли</b> (было ${escape(formatDate(from))})\n\n${formatTask(task, now)}`);
  }
  for (const [hours, list] of [...reminders].sort((a, b) => a[0] - b[0])) {
    messages.push(`<b>${reminderTitle(hours)}</b>\n\n${formatList(list, now)}`);
  }

  for (const text of messages) await send(CHAT_ID, text);
  saveState(state);
  await refreshSummary(tasks, now);
  console.log(new Date().toISOString(), `tasks=${tasks.length} posted=${messages.length}`);
}

// The latest group summary stays pinned; the previous one is unpinned so the
// topic shows a single current list.
const PINNED_FILE = `${DATA_DIR}/pinned.json`;
const pinnedId = () => (existsSync(PINNED_FILE) ? JSON.parse(readFileSync(PINNED_FILE, "utf8")).messageId : null);

async function repin(messageId, previous) {
  await bot.api.pinChatMessage(CHAT_ID, messageId, { disable_notification: true });
  if (previous && previous !== messageId) {
    await bot.api.unpinChatMessage(CHAT_ID, previous).catch((err) => console.error("unpin failed:", err.description));
  }
}

async function pinSummary(messageId) {
  const previous = pinnedId();
  await repin(messageId, previous);
  writeFileSync(PINNED_FILE, JSON.stringify({ messageId }));
}

// Resolves to false once the message is gone (deleted by someone), so the
// caller stops editing it.
function editMessage(messageId, text) {
  return bot.api
    .editMessageText(CHAT_ID, messageId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } })
    .then(() => true)
    .catch((err) => {
      const reason = err.description ?? err.message;
      if (/not modified/.test(reason)) return true;
      console.error("edit failed:", reason);
      return !/not found|can't be edited/.test(reason);
    });
}

// Between /deadlines calls the pinned summary is rewritten in place after each
// poll: fresh "time left", new tasks in, passed ones out.
async function refreshSummary(tasks, now) {
  const messageId = pinnedId();
  if (!messageId) return;
  if (!(await editMessage(messageId, renderList(tasks, now, true)))) rmSync(PINNED_FILE, { force: true });
}

// Drop the "bot pinned a message" service line the pin leaves in the topic.
bot.on("message:pinned_message", async (ctx, next) => {
  if (String(ctx.chat.id) !== CHAT_ID || ctx.from?.id !== ctx.me.id) return next();
  await ctx.deleteMessage().catch((err) => console.error("delete pin notice failed:", err.description));
});

const lastRun = new Map();
bot.on("message:text", async (ctx, next) => {
  const verdict = guardCommand(
    {
      text: ctx.msg.text,
      chatId: ctx.chat.id,
      chatType: ctx.chat.type,
      threadId: ctx.msg.message_thread_id,
      userId: ctx.from.id,
      now: Date.now(),
    },
    lastRun,
    {
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      botUsername: ctx.me.username,
      groupCooldownMs: GROUP_COOLDOWN_SEC * 1000,
      privateCooldownMs: PRIVATE_COOLDOWN_SEC * 1000,
      ownerId: OWNER_ID,
    },
  );
  if (!verdict) return next();
  console.log(new Date().toISOString(), `/${verdict.command} from ${ctx.from.id} in ${ctx.chat.id}#${ctx.msg.message_thread_id ?? "-"}`, verdict);
  if (verdict.remove) await ctx.deleteMessage().catch((err) => console.error("delete failed:", err.description));
  if (verdict.run) return next();
});

bot.command(["start", "help"], (ctx) =>
  ctx.reply(
    [
      "Слежу за дедлайнами в LMS ЦУ и пишу сюда:",
      "• когда появляется новое задание,",
      `• за ${REMIND_HOURS.map((h) => (h >= 24 ? `${h / 24} дн` : `${h} ч`)).join(", ")} до дедлайна,`,
      "• если дедлайн перенесли.",
      "",
      `/deadlines — сводка на ${LIST_DAYS} дней. Пиши в любой теме: команда удалится, а сводка придёт сюда (не чаще раза в час).`,
      ...(SCHEDULE_ICS_URL
        ? ["", `В теме расписания каждый день в ${SCHEDULE_TIME} пишу, какие сегодня пары, и сообщаю, если пару перенесли или отменили.`]
        : []),
      ...(PUBLIC_URL ? ["", `Дедлайны в своём календаре: ${PUBLIC_URL}`] : []),
    ].join("\n"),
    { link_preview_options: { is_disabled: true } },
  ),
);

bot.command("deadlines", async (ctx) => {
  try {
    const inGroup = String(ctx.chat.id) === CHAT_ID;
    const text = renderList(await fetchTasks(), Date.now(), inGroup);
    const msg = await ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    if (inGroup) await pinSummary(msg.message_id);
  } catch (err) {
    console.error(err);
    await ctx.reply("Не получилось достучаться до LMS, попробуй позже.");
  }
});

bot.command("chatid", (ctx) =>
  ctx.reply(`chat id: <code>${ctx.chat.id}</code>\nyour id: <code>${ctx.from?.id}</code>`, { parse_mode: "HTML" }),
);

// Owner-only, private chat only: swaps in a fresh bff.cookie after `bun run login`.
bot.command("session", async (ctx) => {
  if (ctx.chat.type !== "private" || String(ctx.from?.id) !== OWNER_ID) return;
  const value = ctx.match.trim();
  await ctx.deleteMessage().catch(() => {});
  if (!value) return ctx.reply("Формат: /session <cookie>");
  const previous = loadState();
  setCookie(value);
  try {
    const me = await getMe();
    previous.sessionAlerted = false;
    saveState(previous);
    await ctx.reply(`✅ Сессия обновлена: ${me.firstName} ${me.lastName}`);
  } catch (err) {
    await ctx.reply(`❌ Кука не подошла: ${err.message}`);
  }
});

bot.catch((err) => console.error(err));

// Optional contest countdown (CONTEST_URL, see README), posted with a screenshot
// of the contest page. Checked every minute so
// the "1 hour left" post isn't up to a whole LMS poll late; the contest JSON
// itself is refetched once per poll and right before posting.
const CONTEST_FILE = `${DATA_DIR}/contest.json`;
let contest = null;
let contestFetchedAt = 0;

async function fetchContest() {
  const res = await fetch(CONTEST_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`contest ${CONTEST_URL} → ${res.status}`);
  contest = await res.json();
  contestFetchedAt = Date.now();
  return contest;
}

// Tries each photo source in turn; the post goes out as text if none works.
async function sendWithPhoto(text, ...photos) {
  for (const photo of photos) {
    try {
      const file = await photo();
      if (file) return await bot.api.sendPhoto(CHAT_ID, file, { caption: text, parse_mode: "HTML" });
    } catch (err) {
      console.error("contest photo failed:", err.description ?? err.message);
    }
  }
  await send(CHAT_ID, text);
}

const pageShot = (contest) => async () => {
  const jpeg = await screenshot(contest.url);
  return jpeg && new InputFile(jpeg, "contest.jpg");
};

// The result shows the winning card's own image (the future group avatar);
// a tie or a card without one falls back to a screenshot of the page.
function postResult(contest) {
  const [winner, ...tie] = winners(contest.entries);
  // Uploaded, not passed by URL: Telegram rejects some formats (webp) by link.
  const winnerImage = async () => winner?.imageUrl && !tie.length && new InputFile(new URL(winner.imageUrl));
  return sendWithPhoto(formatResult(contest), winnerImage, pageShot(contest));
}

async function contestTick() {
  const now = Date.now();
  if (now - contestFetchedAt >= POLL_MINUTES * 60_000) await fetchContest();
  const state = existsSync(CONTEST_FILE) ? JSON.parse(readFileSync(CONTEST_FILE, "utf8")) : {};
  const event = contestEvent(state, contest, now, CONTEST_REMIND_HOURS);
  if (event) {
    // Post the current standings, not the ones cached up to a poll ago. A
    // failed post leaves the state unsaved, so it's retried next minute.
    await fetchContest();
    if (event.type === "reminder") await sendWithPhoto(formatReminder(contest, event.hours), pageShot(contest));
    else await postResult(contest);
    console.log(new Date().toISOString(), `contest ${event.type}`, event.hours ?? "");
  }
  writeFileSync(CONTEST_FILE, JSON.stringify(state));
}

async function contestLoop() {
  try {
    await contestTick();
  } catch (err) {
    console.error(new Date().toISOString(), "contest:", err.message);
  }
  setTimeout(contestLoop, 60_000);
}

// Optional schedule topic (SCHEDULE_ICS_URL, see README). The calendar is
// polled every SCHEDULE_POLL_MINUTES for changes in the next SCHEDULE_DAYS;
// the minute timer only makes the morning post land on time.
const SCHEDULE_FILE = `${DATA_DIR}/schedule.json`;
const DAY_MS = 86_400_000;
// How far ahead the snapshot reaches, so a class moved from further out into
// the next few days reads as moved, not as new.
const SCHEDULE_HORIZON_MS = 60 * DAY_MS;
let scheduleFetchedAt = 0;

async function fetchSchedule(now) {
  const res = await fetch(SCHEDULE_ICS_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`schedule calendar → ${res.status}`);
  const classes = parseSchedule(await res.text(), {
    from: now - DAY_MS,
    to: now + SCHEDULE_HORIZON_MS,
    organizer: SCHEDULE_ORGANIZER,
  });
  scheduleFetchedAt = now;
  return classes;
}

const sendSchedule = (text, extra = {}) =>
  bot.api.sendMessage(CHAT_ID, text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(SCHEDULE_THREAD_ID && { message_thread_id: Number(SCHEDULE_THREAD_ID) }),
    ...extra,
  });

async function scheduleTick() {
  const now = Date.now();
  const today = dayKey(now);
  const state = existsSync(SCHEDULE_FILE) ? JSON.parse(readFileSync(SCHEDULE_FILE, "utf8")) : { classes: null };
  const dailyDue = state.daily?.date !== today && localTime(now) >= SCHEDULE_TIME;
  if (!dailyDue && now - scheduleFetchedAt < SCHEDULE_POLL_MINUTES * 60_000) return;

  const classes = await fetchSchedule(now);
  // The first run only takes a snapshot. State is saved right after the post,
  // so a failure further down can't repeat it.
  const changes = state.classes ? diffSchedule(state, classes, now, SCHEDULE_DAYS * DAY_MS) : [];
  if (changes.length) await sendSchedule(formatChanges(changes));
  state.classes = Object.fromEntries(classes.map((c) => [c.key, c]));
  state.until = now + SCHEDULE_HORIZON_MS;
  writeAtomic(SCHEDULE_FILE, JSON.stringify(state));

  // Today's post is pinned in the topic and follows changes during the day.
  const text = formatDay(classes.filter((c) => dayKey(c.start) === today), now);
  if (dailyDue) {
    const quiet = !classes.some((c) => dayKey(c.start) === today);
    const msg = await sendSchedule(text, { disable_notification: quiet });
    const previous = state.daily?.messageId;
    state.daily = { date: today, messageId: msg.message_id, text };
    writeAtomic(SCHEDULE_FILE, JSON.stringify(state));
    await repin(msg.message_id, previous).catch((err) => console.error("schedule pin failed:", err.description));
  } else if (state.daily?.date === today && state.daily.messageId && state.daily.text !== text) {
    if (!(await editMessage(state.daily.messageId, text))) state.daily.messageId = null;
    state.daily.text = text;
    writeAtomic(SCHEDULE_FILE, JSON.stringify(state));
  }
  console.log(new Date().toISOString(), `schedule classes=${classes.length} changes=${changes.length}${dailyDue ? " daily" : ""}`);
}

async function scheduleLoop() {
  try {
    await scheduleTick();
  } catch (err) {
    console.error(new Date().toISOString(), "schedule:", err.message);
  }
  setTimeout(scheduleLoop, 60_000);
}

// PUBLIC_URL turns on a tiny web server: the deadlines feed and a page with
// subscribe links. The feed is the file the last LMS poll wrote.
const FEED_FILE = `${DATA_DIR}/deadlines.ics`;

function serve() {
  const page = subscribePage(FEED_URL);
  Bun.serve({
    port: Number(process.env.PORT || 3000),
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/deadlines.ics") {
        if (!existsSync(FEED_FILE)) return new Response("Календарь ещё собирается, попробуй через минуту", { status: 503 });
        return new Response(Bun.file(FEED_FILE), {
          headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "public, max-age=300" },
        });
      }
      if (pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response("Not found", { status: 404 });
    },
  });
  console.log(`calendar feed at ${FEED_URL}`);
}

async function loop() {
  try {
    await tick();
  } catch (err) {
    console.error(new Date().toISOString(), err.message);
  }
  setTimeout(loop, POLL_MINUTES * 60_000);
}

await bot.api.setMyCommands([
  { command: "deadlines", description: "Ближайшие дедлайны" },
  { command: "help", description: "Что умеет бот" },
]);
if (!CHAT_ID) console.warn("CHAT_ID is not set: add the bot to the group, send /chatid, put the id in .env");
if (PUBLIC_URL) serve();
loop();
if (CONTEST_URL && CHAT_ID) contestLoop();
if (SCHEDULE_ICS_URL && CHAT_ID) scheduleLoop();
bot.start({ onStart: (me) => console.log(`@${me.username} started`) });
