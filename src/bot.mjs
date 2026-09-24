import { Bot } from "grammy";
import { SessionExpiredError, getMe, getUpcomingTasks, setCookie } from "./lib/lms.mjs";
import { loadState, saveState } from "./lib/store.mjs";
import { diff } from "./lib/diff.mjs";
import { guardCommand } from "./lib/guard.mjs";
import { escape, formatDate, formatList, formatTask } from "./lib/format.mjs";

const { BOT_TOKEN, CHAT_ID, OWNER_ID, THREAD_ID } = process.env;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set in .env");

const REMIND_HOURS = (process.env.REMIND_HOURS || "72,24,3").split(",").map(Number);
const POLL_MINUTES = Number(process.env.POLL_MINUTES || 30);
const LIST_DAYS = Number(process.env.LIST_DAYS || 14);
const GROUP_COOLDOWN_SEC = Number(process.env.GROUP_COOLDOWN_SEC || 3600);
const PRIVATE_COOLDOWN_SEC = Number(process.env.PRIVATE_COOLDOWN_SEC || 30);
const EXCLUDE = process.env.EXCLUDE_COURSES ? new RegExp(process.env.EXCLUDE_COURSES, "i") : null;

const bot = new Bot(BOT_TOKEN);

// In the forum group every outgoing message goes to the deadlines topic, even
// a reply to a command typed in another topic: ctx.reply would otherwise answer
// in whatever topic the command came from.
if (CHAT_ID && THREAD_ID) {
  bot.api.config.use((prev, method, payload, signal) => {
    if (method.startsWith("send") && String(payload?.chat_id) === CHAT_ID) {
      payload = { ...payload, message_thread_id: Number(THREAD_ID) };
      delete payload.reply_parameters;
    }
    return prev(method, payload, signal);
  });
}

const send = (chatId, text) =>
  bot.api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });

async function fetchTasks() {
  const tasks = await getUpcomingTasks();
  return EXCLUDE ? tasks.filter((t) => !EXCLUDE.test(t.course)) : tasks;
}

function renderList(tasks, now) {
  const soon = tasks.filter((t) => Date.parse(t.deadline) <= now + LIST_DAYS * 86_400_000);
  return soon.length
    ? `<b>Дедлайны на ${LIST_DAYS} дней</b>\n\n${formatList(soon, now)}`
    : `На ближайшие ${LIST_DAYS} дней дедлайнов нет 🎉`;
}


function reminderTitle(hours) {
  if (hours >= 48) return `📅 Через ${Math.round(hours / 24)} дня дедлайн`;
  if (hours >= 24) return "⚠️ Дедлайн завтра";
  return `🔥 Дедлайн через ${hours} ч`;
}

async function tick() {
  const state = loadState();
  let tasks;
  try {
    tasks = await fetchTasks();
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
  console.log(new Date().toISOString(), `tasks=${tasks.length} posted=${messages.length}`);
}

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
    ].join("\n"),
  ),
);

bot.command("deadlines", async (ctx) => {
  try {
    const text = renderList(await fetchTasks(), Date.now());
    await ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
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
loop();
bot.start({ onStart: (me) => console.log(`@${me.username} started`) });
