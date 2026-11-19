import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTranscript,
  countMessages,
  messageLink,
  parseWindow,
  plural,
  renderSummary,
  splitMessage,
  summarize,
  windowLabel,
  windowSpec,
} from "../src/lib/summary.mjs";

const limits = { maxDays: 7, minMessages: 10, maxMessages: 1000 };

test("plural picks the Russian form", () => {
  const hours = ["час", "часа", "часов"];
  assert.deepEqual([1, 2, 5, 11, 21, 22, 112].map((n) => plural(n, hours)), ["час", "часа", "часов", "часов", "час", "часа", "часов"]);
  assert.equal(countMessages(312), "312 сообщений");
});

test("window: empty, days, count", () => {
  assert.deepEqual(parseWindow("", limits), { kind: "since" });
  assert.deepEqual(parseWindow("1d", limits), { kind: "days", days: 1 });
  assert.deepEqual(parseWindow(" 3D ", limits), { kind: "days", days: 3 });
  assert.deepEqual(parseWindow("7д", limits), { kind: "days", days: 7 });
  assert.deepEqual(parseWindow("2 дня", limits), { kind: "days", days: 2 });
  assert.deepEqual(parseWindow("5 days", limits), { kind: "days", days: 5 });
  assert.deepEqual(parseWindow("10", limits), { kind: "count", count: 10 });
  assert.deepEqual(parseWindow("1000", limits), { kind: "count", count: 1000 });
});

test("window: nonsense and out of range are refused", () => {
  for (const arg of ["вчера", "24h", "-5", "0d", "8d", "9", "1001", "1.5d", "3 d 4"]) assert.equal(parseWindow(arg, limits), null, arg);
});

test("window spec survives a start link", () => {
  for (const arg of ["", "1d", "7д", "200"]) {
    const window = parseWindow(arg, limits);
    assert.match(windowSpec(window), /^\w*$/);
    assert.deepEqual(parseWindow(windowSpec(window), limits), window);
  }
});

test("window label", () => {
  assert.equal(windowLabel({ kind: "days", days: 1 }), "за сутки");
  assert.equal(windowLabel({ kind: "days", days: 3 }), "за 3 дня");
  assert.equal(windowLabel({ kind: "days", days: 7 }), "за 7 дней");
  assert.equal(windowLabel({ kind: "count", count: 200 }), "последние 200 сообщений");
  assert.match(windowLabel({ kind: "since" }, Date.parse("2026-11-18T18:00:00Z")), /^с твоего последнего сообщения \(ср, 18 ноября в 21:00\)$/);
});

const at = (iso) => Date.parse(iso);
const messages = [
  { id: 10, threadId: null, userId: 1, name: "Аня", text: "Матан перенесли\nна пятницу", replyTo: null, date: at("2026-11-18T09:00:00Z") },
  { id: 11, threadId: 7, userId: 2, name: "Петя", text: "Кто идёт в кино?", replyTo: null, date: at("2026-11-18T09:01:00Z") },
  { id: 12, threadId: null, userId: 2, name: "Петя", text: "ок", replyTo: 10, date: at("2026-11-18T09:02:00Z") },
  { id: 13, threadId: 9, userId: 3, name: "Оля", text: "<b>тест</b>", replyTo: null, date: at("2026-11-18T09:03:00Z") },
];

test("transcript groups messages by topic, one line each", () => {
  const text = buildTranscript(messages, new Map([[7, "Досуг"]]), { period: "за сутки", now: at("2026-11-18T18:00:00Z") });
  assert.equal(
    text,
    [
      "Период: за сутки. Сейчас среда, 18 ноября 2026 г. в 21:00 (Europe/Moscow).",
      "",
      "## Тема: Общий чат",
      "[10] Ср, 18.11, 12:00 Аня: Матан перенесли ⏎ на пятницу",
      "[12] Ср, 18.11, 12:02 Петя ↩ 10: ок",
      "",
      "## Тема: Досуг",
      "[11] Ср, 18.11, 12:01 Петя: Кто идёт в кино?",
      "",
      "## Тема: Тема 9",
      "[13] Ср, 18.11, 12:03 Оля: <b>тест</b>",
    ].join("\n"),
  );
});

test("transcript uses the group's own name for the general topic", () => {
  const text = buildTranscript(messages.slice(0, 1), new Map(), { period: "за сутки", now: 0, general: "Курилка" });
  assert.match(text, /^## Тема: Курилка$/m);
});

test("message links: topic in the path, none outside a supergroup", () => {
  assert.equal(messageLink("-1001234567890", null, 55), "https://t.me/c/1234567890/55");
  assert.equal(messageLink("-1001234567890", 7, 55), "https://t.me/c/1234567890/7/55");
  assert.equal(messageLink("-4123", null, 55), null);
});

const result = {
  important: [{ label: "Матан <перенос>", text: "Семинар перенесли на пятницу & точка.", message_id: 10 }],
  sections: [
    { title: "Досуг", points: [{ label: "Кино", text: "Петя зовёт в кино.", message_id: 11 }] },
    { title: "Пусто", points: [] },
    { title: "Выдумка", points: [{ label: "Нет такого", text: "Ссылка на чужое сообщение.", message_id: 999 }] },
  ],
};

test("render: escaped text, links only to messages that were read", () => {
  const html = renderSummary(result, { heading: "Что было в чате", period: "за сутки", messages, chatId: "-1001234567890" });
  assert.equal(
    html,
    [
      "<b>🗞 Что было в чате</b>",
      "<i>за сутки, 4 сообщения от 3 человек</i>",
      "",
      "<b>❗️ Важное</b>",
      '• <a href="https://t.me/c/1234567890/10">Матан &lt;перенос&gt;</a>: Семинар перенесли на пятницу &amp; точка.',
      "",
      "<b>💬 Досуг</b>",
      '• <a href="https://t.me/c/1234567890/7/11">Кино</a>: Петя зовёт в кино.',
      "",
      "<b>💬 Выдумка</b>",
      "• <b>Нет такого</b>: Ссылка на чужое сообщение.",
    ].join("\n"),
  );
});

test("render: nothing to tell, and a note when the window was cut", () => {
  const empty = renderSummary({ important: [], sections: [] }, { heading: "Что было в чате", period: "за сутки", messages, total: 9, chatId: "-100123" });
  assert.match(empty, /Ничего такого, что стоило бы пересказывать\./);
  assert.match(empty, /<i>Здесь последние 4 из 9 сообщений за это время\.<\/i>$/);
});

test("split keeps lines whole and under the limit", () => {
  const html = ["<b>a</b>", "", "x".repeat(30), "y".repeat(30), "", "z".repeat(30)].join("\n");
  const parts = splitMessage(html, 50);
  assert.deepEqual(parts, ["<b>a</b>\n\n" + "x".repeat(30), "y".repeat(30), "z".repeat(30)]);
  assert.deepEqual(splitMessage("short"), ["short"]);
});

const answer = { important: [], sections: [{ title: "Досуг", points: [{ label: "Кино", text: "Идут.", message_id: 11 }] }] };
const completion = (finish_reason = "stop") => ({ choices: [{ finish_reason, message: { role: "assistant", content: JSON.stringify(answer) } }] });
// Answers each request with the next `[status, body]` and remembers the requests.
function fakeFetch(...replies) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const [status, body] = replies[Math.min(calls.length, replies.length) - 1];
    if (status === "network") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch, calls };
}
const ask = (fetch, extra = {}) => summarize({ apiKey: "key", model: "anthropic/claude-haiku-5.5", transcript: "чат", fetch, retryDelayMs: 0, ...extra });

test("summarize sends the transcript to OpenRouter and parses the JSON answer", async () => {
  const { fetch, calls } = fakeFetch([200, completion()]);
  assert.deepEqual(await ask(fetch, { proxy: "http://proxy:8080" }), answer);
  const [{ url, init, body }] = calls;
  assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(init.headers.authorization, "Bearer key");
  assert.equal(init.proxy, "http://proxy:8080");
  assert.equal(body.model, "anthropic/claude-haiku-5.5");
  assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
  assert.equal(body.messages[1].content, "чат");
  assert.equal(body.response_format.json_schema.strict, true);
});

test("summarize tries a busy provider once more", async () => {
  for (const first of [[503, { error: { message: "overloaded", code: 503 } }], [200, { error: { message: "rate limited", code: 429 } }], ["network"]]) {
    const { fetch, calls } = fakeFetch(first, [200, completion()]);
    assert.deepEqual(await ask(fetch), answer);
    assert.equal(calls.length, 2);
  }
  const { fetch, calls } = fakeFetch([503, { error: { message: "overloaded", code: 503 } }]);
  await assert.rejects(ask(fetch), { message: "overloaded", status: 503 });
  assert.equal(calls.length, 2);
});

test("summarize fails at once on a bad key, an empty account or a cut-off answer", async () => {
  for (const [status, message] of [[401, "No auth credentials found"], [402, "Insufficient credits"]]) {
    const { fetch, calls } = fakeFetch([status, { error: { message, code: status } }]);
    await assert.rejects(ask(fetch), { message, status });
    assert.equal(calls.length, 1);
  }
  const cut = fakeFetch([200, completion("length")]);
  await assert.rejects(ask(cut.fetch), /stopped with length/);
  assert.equal(cut.calls.length, 1);
});
