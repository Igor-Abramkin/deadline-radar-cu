// `bun run setup`: walks a new owner through the Telegram bot, the LMS login
// and the group, then writes .env (local run) and deploy.env (server) and
// prints deploy steps for the chosen hosting.
import * as p from "@clack/prompts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Api, GrammyError } from "grammy";
import { repoUrl, showDeployGuide } from "./deploy.mjs";

const ENV_FILE = ".env";
const DEPLOY_ENV_FILE = "deploy.env";
const DATA_DIR = process.env.DATA_DIR || "data";
const current = readEnv(ENV_FILE);

p.intro(" Deadline Radar · настройка ");

const { api, bot } = await setupBot();
const student = await setupLms();
const group = await setupGroup(api, bot);
const options = await setupOptions();

const values = {
  BOT_TOKEN: api.token,
  CHAT_ID: group.chatId,
  THREAD_ID: group.threadId ?? "",
  OWNER_ID: group.ownerId,
  ...options,
};
writeEnv(ENV_FILE, { ...current, ...values, CU_COOKIE: undefined });
writeEnv(DEPLOY_ENV_FILE, { ...values, CU_COOKIE: readFileSync(`${DATA_DIR}/cookie.txt`, "utf8").trim() });
p.log.success(`Записал ${ENV_FILE} (для запуска на этом компьютере) и ${DEPLOY_ENV_FILE} (для сервера).`);
p.log.warn(
  `В ${DEPLOY_ENV_FILE} лежит сессия LMS (${student}): с ней можно зайти в твой аккаунт. Не коммить файл и никому его не отправляй.`,
);

p.log.step("Шаг 4 из 4 · запуск");
if (!(await showDeployGuide({ repo: repoUrl(), bot: bot.username }))) stop();

p.outro(
  [
    "После запуска бот молча запомнит текущие задания и дальше будет писать только о новых и о дедлайнах.",
    `Проверить: отправь /deadlines в группе. Если сессия LMS истечёт, бот напишет тебе в личку.`,
  ].join("\n   "),
);

// --- steps -------------------------------------------------------------------

async function setupBot() {
  p.note(
    [
      "1. Открой @BotFather в Telegram и отправь /newbot.",
      "2. Придумай имя и username (он должен заканчиваться на bot).",
      "3. BotFather пришлёт токен вида 1234567890:AAE…",
    ].join("\n"),
    "Шаг 1 из 4 · бот в Telegram",
  );
  for (;;) {
    const token = await ask(
      p.text({
        message: "Токен бота",
        initialValue: current.BOT_TOKEN,
        validate: (v) => (/^\d+:[\w-]{30,}$/.test(v?.trim() ?? "") ? undefined : "Токен выглядит как 1234567890:AAE…"),
      }),
    );
    const api = new Api(token.trim());
    const s = p.spinner();
    s.start("Проверяю токен");
    try {
      const bot = await api.getMe();
      s.stop(`Бот @${bot.username}`);
      return { api, bot };
    } catch (err) {
      s.error("Telegram не принял токен");
      p.log.error(describe(err));
    }
  }
}

async function setupLms() {
  const { getMe } = await import("../lib/lms.mjs");
  const who = (me) => `${me.firstName} ${me.lastName}`;
  const existing = await getMe().catch(() => null);
  if (existing) {
    const again = await ask(
      p.confirm({ message: `Уже есть сессия LMS: ${who(existing)}. Войти заново?`, initialValue: false }),
    );
    if (!again) return who(existing);
  }

  p.note(
    [
      "Откроется окно браузера со входом в my.centraluniversity.ru.",
      "Войди как обычно: логин, пароль, капча, код из SMS. Окно закроется само.",
      "",
      "Бот видит LMS глазами этого аккаунта: в группу попадут задания",
      "только тех курсов, на которые ты записан.",
    ].join("\n"),
    "Шаг 2 из 4 · вход в LMS",
  );
  await gate("Открыть браузер?");

  const { loginInBrowser } = await import("../lib/browser-login.mjs");
  for (;;) {
    const s = p.spinner();
    s.start("Жду входа в LMS (до 10 минут)");
    try {
      await loginInBrowser({ login: process.env.CU_LOGIN, password: process.env.CU_PASSWORD });
      const me = await getMe();
      s.stop(`Вошли в LMS: ${who(me)}`);
      return who(me);
    } catch (err) {
      s.error("Вход не удался");
      p.log.error(err.message);
      await gate("Попробовать ещё раз?");
    }
  }
}

async function setupGroup(api, bot) {
  const known = current.CHAT_ID && (await api.getChat(current.CHAT_ID).catch(() => null));
  if (known && current.OWNER_ID) {
    const keep = await ask(p.confirm({ message: `Оставить группу «${known.title}»?` }));
    if (keep) {
      await checkRights(api, bot, current.CHAT_ID);
      return { chatId: current.CHAT_ID, threadId: current.THREAD_ID || undefined, ownerId: current.OWNER_ID };
    }
  }

  // Skip whatever the bot received before this run, so an old message doesn't
  // pick the wrong chat.
  let offset = await pendingOffset(api);

  p.note(
    [
      `1. Добавь @${bot.username} в группу (или в группу с темами).`,
      "2. Сделай его администратором. Нужны права:",
      "   • удаление сообщений — бот убирает команды, чтобы не засорять чат;",
      "   • закрепление сообщений — бот закрепляет свежую сводку дедлайнов;",
      "   • управление темами — если тема для дедлайнов закрыта для участников.",
      "3. Напиши любое сообщение туда, куда бот будет присылать дедлайны:",
      "   в нужную тему или просто в группу, если тем нет.",
    ].join("\n"),
    "Шаг 3 из 4 · группа",
  );

  for (;;) {
    const s = p.spinner();
    s.start("Жду сообщение в группе");
    let found;
    try {
      ({ found, offset } = await waitForGroupMessage(api, offset, 5 * 60_000));
    } catch (err) {
      s.error("Не получилось читать сообщения бота");
      p.log.error(describe(err));
      if (err instanceof GrammyError && /webhook/i.test(err.description)) {
        const drop = await ask(p.confirm({ message: "У бота включён вебхук. Отключить?" }));
        if (drop) await api.deleteWebhook();
      } else {
        await gate("Проверить снова?");
      }
      continue;
    }
    if (!found) {
      s.error("Сообщение не пришло");
      await gate("Подождать ещё?");
      continue;
    }

    const place = found.threadId ? `тема #${found.threadId}` : "без темы";
    s.stop(`Группа «${found.title}», ${place}`);
    const ok = await ask(p.confirm({ message: "Сюда бот будет присылать дедлайны. Всё верно?" }));
    if (!ok) {
      p.log.info("Напиши сообщение в другое место.");
      continue;
    }

    const ownerId = await pickOwner(api, bot, found.from);
    await checkRights(api, bot, found.chatId);
    await api
      .sendMessage(found.chatId, "📡 Deadline Radar подключён. Сюда будут приходить новые задания и напоминания о дедлайнах.", {
        message_thread_id: found.threadId,
      })
      .then(() => p.log.success("Отправил в группу проверочное сообщение."))
      .catch((err) => p.log.warn(`Не смог написать в группу: ${describe(err)}`));
    return { chatId: found.chatId, threadId: found.threadId, ownerId };
  }
}

async function pickOwner(api, bot, from) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") + (from.username ? ` (@${from.username})` : "");
  const me = await ask(
    p.confirm({
      message: `Владелец бота — ${name}? Ему бот пишет, когда истекает сессия LMS, и на него не действуют лимиты команд.`,
    }),
  );
  const ownerId = me
    ? String(from.id)
    : await ask(
        p.text({
          message: "Telegram id владельца (узнать можно у @userinfobot)",
          validate: (v) => (/^\d+$/.test(v?.trim() ?? "") ? undefined : "Нужно число"),
        }),
      ).then((v) => v.trim());

  // The bot can't open a private chat by itself: the owner has to press Start.
  for (;;) {
    try {
      await api.sendMessage(ownerId, "Ты владелец этого бота. Сюда придёт сообщение, если сессия LMS истечёт.");
      p.log.success("Бот может писать владельцу в личку.");
      return ownerId;
    } catch (err) {
      p.log.warn(`Бот не может написать владельцу: ${describe(err)}`);
      const retry = await ask(
        p.confirm({ message: `Открой t.me/${bot.username} и нажми «Start». Проверить снова?` }),
      );
      if (!retry) return ownerId;
    }
  }
}

async function checkRights(api, bot, chatId) {
  for (;;) {
    const member = await api.getChatMember(chatId, bot.id).catch(() => null);
    const missing = [];
    if (member?.status !== "administrator") missing.push("бот не администратор");
    else {
      if (!member.can_delete_messages) missing.push("удаление сообщений");
      if (!member.can_pin_messages) missing.push("закрепление сообщений");
    }
    if (!missing.length) return p.log.success("Права администратора на месте.");
    p.log.warn(`Не хватает прав: ${missing.join(", ")}.`);
    const retry = await ask(p.confirm({ message: "Выдал права, проверить снова?" }));
    if (!retry) return p.log.warn("Продолжаю без них: бот не сможет удалять команды и закреплять сводку.");
  }
}

async function setupOptions() {
  const defaults = {
    REMIND_HOURS: current.REMIND_HOURS || "72,24,3",
    LIST_DAYS: current.LIST_DAYS || "14",
    EXCLUDE_COURSES: current.EXCLUDE_COURSES ?? "Ознакомление",
  };
  const custom = await ask(
    p.confirm({
      message: `Напоминания за ${defaults.REMIND_HOURS} ч, сводка на ${defaults.LIST_DAYS} дней, скрывать курсы: ${defaults.EXCLUDE_COURSES || "нет"}. Изменить?`,
      initialValue: false,
    }),
  );
  if (!custom) return defaults;

  const REMIND_HOURS = await ask(
    p.text({
      message: "За сколько часов до дедлайна напоминать (через запятую)",
      initialValue: defaults.REMIND_HOURS,
      validate: (v) => (/^\s*\d+(\s*,\s*\d+)*\s*$/.test(v ?? "") ? undefined : "Например: 72,24,3"),
    }),
  );
  const LIST_DAYS = await ask(
    p.text({
      message: "На сколько дней вперёд показывать /deadlines",
      initialValue: defaults.LIST_DAYS,
      validate: (v) => (/^\d+$/.test(v?.trim() ?? "") ? undefined : "Нужно число"),
    }),
  );
  const EXCLUDE_COURSES = await ask(
    p.text({
      message: "Скрывать курсы, в названии которых есть (регулярное выражение, можно пусто)",
      initialValue: defaults.EXCLUDE_COURSES,
      validate: (v) => {
        try {
          new RegExp(v ?? "");
        } catch {
          return "Некорректное регулярное выражение";
        }
      },
    }),
  );
  return { REMIND_HOURS: REMIND_HOURS.replace(/\s/g, ""), LIST_DAYS: LIST_DAYS.trim(), EXCLUDE_COURSES: EXCLUDE_COURSES ?? "" };
}

// --- helpers -----------------------------------------------------------------

async function ask(prompt) {
  const value = await prompt;
  if (p.isCancel(value)) stop();
  return value;
}

// A yes/no question where "no" means "not now": stops the wizard.
async function gate(message) {
  if (!(await ask(p.confirm({ message })))) stop();
}

function stop() {
  p.cancel("Настройка прервана. Запусти `bun run setup` ещё раз, когда будешь готов.");
  process.exit(0);
}

async function pendingOffset(api) {
  const updates = await api.getUpdates({ offset: -1, timeout: 0 }).catch(() => []);
  return updates.length ? updates.at(-1).update_id + 1 : 0;
}

async function waitForGroupMessage(api, offset, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const updates = await api.getUpdates({ offset, timeout: 20, allowed_updates: ["message"] });
    for (const { update_id, message: m } of updates) {
      offset = update_id + 1;
      if (!m || !["group", "supergroup"].includes(m.chat.type) || !m.from || m.from.is_bot) continue;
      // Turning on topics converts a group to a supergroup with a new id.
      if (m.migrate_to_chat_id) continue;
      await api.getUpdates({ offset, timeout: 0 }); // mark as read so the bot won't replay it
      return {
        offset,
        found: {
          chatId: String(m.chat.id),
          title: m.chat.title,
          threadId: m.is_topic_message ? String(m.message_thread_id) : undefined,
          from: m.from,
        },
      };
    }
  }
  return { offset, found: null };
}

function describe(err) {
  if (!(err instanceof GrammyError)) return err.message;
  if (err.error_code === 401) return "неверный токен";
  if (err.error_code === 409 && !/webhook/i.test(err.description))
    return "этот бот уже запущен где-то ещё (локально или на сервере). Останови его на время настройки.";
  if (err.error_code === 403) return "пользователь не начал диалог с ботом";
  return err.description;
}

function readEnv(file) {
  if (!existsSync(file)) return {};
  const env = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return env;
}

// Unquoted KEY=value lines: the only format that .env loaders, `docker --env-file`
// and hosting panels all read the same way.
function writeEnv(file, env) {
  const lines = Object.entries(env)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
}
