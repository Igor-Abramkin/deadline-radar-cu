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
const schedule = await setupSchedule(api, group);
const feed = await setupFeed();

const values = {
  BOT_TOKEN: api.token,
  CHAT_ID: group.chatId,
  THREAD_ID: group.threadId ?? "",
  OWNER_ID: group.ownerId,
  ...options,
  ...schedule,
  ...feed,
};
writeEnv(ENV_FILE, { ...current, ...values, CU_COOKIE: undefined });
writeEnv(DEPLOY_ENV_FILE, { ...values, CU_COOKIE: readFileSync(`${DATA_DIR}/cookie.txt`, "utf8").trim() });
p.log.success(`Записал ${ENV_FILE} (для запуска на этом компьютере) и ${DEPLOY_ENV_FILE} (для сервера).`);
p.log.warn(
  [
    `В ${DEPLOY_ENV_FILE} лежит сессия LMS (${student}): с ней можно зайти в твой аккаунт.`,
    schedule.SCHEDULE_ICS_URL && "Там же ссылка на твой календарь: по ней видно все его события.",
    "Не коммить файл и никому его не отправляй.",
  ]
    .filter(Boolean)
    .join(" "),
);

p.log.step("Шаг 5 из 5 · запуск");
if (!(await showDeployGuide({ repo: repoUrl(), bot: bot.username, publicUrl: feed.PUBLIC_URL }))) stop();

p.outro(
  [
    "После запуска бот молча запомнит текущие задания и дальше будет писать только о новых и о дедлайнах.",
    schedule.SCHEDULE_ICS_URL &&
      `В тему расписания бот сразу пришлёт пары на сегодня (если уже больше ${schedule.SCHEDULE_TIME}), дальше — каждый день.`,
    feed.PUBLIC_URL && `Страница с подпиской на календарь: ${feed.PUBLIC_URL}`,
    `Проверить: отправь /deadlines в группе. Если сессия LMS истечёт, бот напишет тебе в личку.`,
  ]
    .filter(Boolean)
    .join("\n   "),
);

// --- steps -------------------------------------------------------------------

async function setupBot() {
  p.note(
    [
      "1. Открой @BotFather в Telegram и отправь /newbot.",
      "2. Придумай имя и username (он должен заканчиваться на bot).",
      "3. BotFather пришлёт токен вида 1234567890:AAE…",
    ].join("\n"),
    "Шаг 1 из 5 · бот в Telegram",
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
    "Шаг 2 из 5 · вход в LMS",
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
    "Шаг 3 из 5 · группа",
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

async function setupSchedule(api, group) {
  p.log.step("Шаг 4 из 5 · расписание и календарь");
  const off = { SCHEDULE_ICS_URL: "", SCHEDULE_THREAD_ID: "" };
  const want = await ask(
    p.confirm({
      message: "Вести в группе отдельную тему с расписанием? Бот каждое утро пишет пары на сегодня и сообщает о переносах.",
      initialValue: Boolean(current.SCHEDULE_ICS_URL),
    }),
  );
  if (!want) return off;

  p.note(
    [
      "Нужна ссылка на экспорт календаря с расписанием в формате iCal.",
      "Яндекс Календарь: наведи на календарь «Расписание ЦУ» в списке слева,",
      "нажми ⚙ → вкладка «Экспорт» → скопируй ссылку для iCal.",
      "Она выглядит как https://calendar.yandex.ru/export/ics.xml?private_token=…",
      "",
      "Бот возьмёт только события от организатора",
      `${process.env.SCHEDULE_ORGANIZER || "timetable@centraluniversity.ru"}: личные в группу не попадут.`,
    ].join("\n"),
    "Расписание",
  );
  const { localTime, parseSchedule } = await import("../lib/schedule.mjs");
  let url;
  for (;;) {
    url = (
      await ask(
        p.text({
          message: "Ссылка на календарь (iCal)",
          initialValue: current.SCHEDULE_ICS_URL,
          validate: (v) => (/^(https?|webcal):\/\/\S+$/.test(v?.trim() ?? "") ? undefined : "Нужна ссылка вида https://…"),
        }),
      )
    )
      .trim()
      .replace(/^webcal:/, "https:");
    const s = p.spinner();
    s.start("Читаю календарь");
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`календарь ответил ${res.status}`);
      const now = Date.now();
      const week = parseSchedule(await res.text(), {
        from: now,
        to: now + 7 * 86_400_000,
        organizer: process.env.SCHEDULE_ORGANIZER ?? "timetable@centraluniversity.ru",
      });
      if (!week.length) {
        s.error("На ближайшую неделю пар нет");
        p.log.warn("Возможно, это не тот календарь, или неделя пустая.");
        if (await ask(p.confirm({ message: "Взять эту ссылку всё равно?", initialValue: false }))) break;
        continue;
      }
      s.stop(`Пар на ближайшую неделю: ${week.length}`);
      const date = new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "short" });
      const preview = week
        .slice(0, 5)
        .map((c) => `${date.format(new Date(c.start))} ${localTime(c.start)}  ${c.title}${c.place ? ` · ${c.place}` : ""}`);
      p.note(preview.join("\n") + (week.length > 5 ? "\n…" : ""), "Ближайшие пары");
      if (await ask(p.confirm({ message: "Это твоё расписание?" }))) break;
    } catch (err) {
      s.error("Не получилось прочитать календарь");
      p.log.error(err.message);
    }
  }

  const threadId = await pickScheduleTopic(api, group);
  if (!threadId) return off;

  const SCHEDULE_TIME = await ask(
    p.text({
      message: "Во сколько присылать пары на сегодня",
      initialValue: current.SCHEDULE_TIME || "09:00",
      validate: (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v?.trim() ?? "") ? undefined : "Время в формате ЧЧ:ММ, например 09:00"),
    }),
  );
  return { SCHEDULE_ICS_URL: url, SCHEDULE_THREAD_ID: threadId, SCHEDULE_TIME: SCHEDULE_TIME.trim() };
}

// The schedule needs a topic of its own in the same group, found the same way
// as the deadlines one: by a message written in it.
async function pickScheduleTopic(api, group) {
  let offset = await pendingOffset(api);
  p.note(
    [
      "1. Создай в группе тему для расписания, например «Расписание».",
      "   Можно закрыть её для участников: писать туда будет только бот.",
      "2. Напиши в неё любое сообщение.",
    ].join("\n"),
    "Тема для расписания",
  );
  for (;;) {
    const s = p.spinner();
    s.start("Жду сообщение в теме расписания");
    let found;
    try {
      ({ found, offset } = await waitForGroupMessage(api, offset, 5 * 60_000));
    } catch (err) {
      s.error("Не получилось читать сообщения бота");
      p.log.error(describe(err));
      await gate("Проверить снова?");
      continue;
    }
    if (!found) {
      s.error("Сообщение не пришло");
      if (!(await ask(p.confirm({ message: "Подождать ещё? («Нет» — без темы расписания)" })))) return null;
      continue;
    }
    if (found.chatId !== group.chatId || !found.threadId) {
      s.error(found.chatId !== group.chatId ? `Это другая группа: «${found.title}»` : "Сообщение не в теме");
      p.log.info("Напиши в тему расписания той же группы, куда приходят дедлайны.");
      continue;
    }
    if (found.threadId === group.threadId) {
      s.error("Это тема дедлайнов");
      p.log.info("Для расписания нужна отдельная тема.");
      continue;
    }
    s.stop(`Тема #${found.threadId}`);
    await api
      .sendMessage(found.chatId, "📚 Сюда будут приходить пары на сегодня и изменения в расписании.", {
        message_thread_id: Number(found.threadId),
      })
      .then(() => p.log.success("Отправил в тему проверочное сообщение."))
      .catch((err) => p.log.warn(`Не смог написать в тему: ${describe(err)}`));
    return found.threadId;
  }
}

async function setupFeed() {
  const want = await ask(
    p.confirm({
      message: "Опубликовать календарь с дедлайнами, на который можно подписаться в Apple, Google или Яндекс Календаре?",
      initialValue: Boolean(current.PUBLIC_URL),
    }),
  );
  if (!want) return { PUBLIC_URL: "" };
  p.note(
    [
      "Бот будет отдавать календарь по HTTPS с порта 3000. Нужен домен на сервере,",
      "где работает бот, например cal.example.com. В Coolify, Dokploy и похожих",
      "панелях его указывают в настройках приложения, остальное покажу на шаге запуска.",
      "Календарь публичный: по ссылке видны названия заданий и курсов.",
    ].join("\n"),
    "Календарь дедлайнов",
  );
  const url = await ask(
    p.text({
      message: "Адрес, по которому бот будет доступен",
      placeholder: "https://cal.example.com",
      initialValue: current.PUBLIC_URL,
      validate: (v) => (/^https?:\/\/[^\s/]+\/?$/.test(v?.trim() ?? "") ? undefined : "Нужен адрес вида https://cal.example.com"),
    }),
  );
  return { PUBLIC_URL: url.trim().replace(/\/+$/, "") };
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
