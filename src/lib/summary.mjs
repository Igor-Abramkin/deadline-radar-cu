import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { InlineKeyboard } from "grammy";

const FILE = `${process.env.DATA_DIR || "data"}/summary.json`;
const MAX_LENGTH = 4096;

export const REFRESH_DATA = "summary:refresh";
const keyboard = new InlineKeyboard().text("🔄 Обновить", REFRESH_DATA);
const options = { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard };

const load = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {});
const save = (s) => writeFileSync(FILE, JSON.stringify(s));

const timeFmt = new Intl.DateTimeFormat("ru-RU", {
  timeZone: process.env.TZ_DISPLAY || "Europe/Moscow",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});

// Keeps one pinned message in the group with the current list and a refresh
// button. The bot edits it in place, so it stays current without anyone
// posting in the (closed) topic and a button press never adds a message.
export function createSummary(api, chatId, render) {
  let state = load();

  async function create(text) {
    const msg = await api.sendMessage(chatId, text, options);
    await api.pinChatMessage(chatId, msg.message_id, { disable_notification: true }).catch((err) => {
      console.error("pin failed:", err.description);
    });
    state = { messageId: msg.message_id };
    save(state);
  }

  return {
    async update(tasks, now = Date.now()) {
      let text = `${render(tasks, now)}\n\n<i>Обновлено ${timeFmt.format(now)}</i>`;
      if (text.length > MAX_LENGTH) text = text.slice(0, MAX_LENGTH - 1) + "…";
      if (!state.messageId) return create(text);
      try {
        await api.editMessageText(chatId, state.messageId, text, options);
      } catch (err) {
        if (err.description?.includes("message is not modified")) return;
        // The pinned message was deleted by hand: post a fresh one.
        if (err.description?.includes("message to edit not found")) return create(text);
        throw err;
      }
    },
  };
}
