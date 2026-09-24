// Refreshes the LMS session when it expired: log in in the browser, then send
// the printed /session command to the bot in a private chat.
import { loginInBrowser } from "./lib/browser-login.mjs";

const cookie = await loginInBrowser({ login: process.env.CU_LOGIN, password: process.env.CU_PASSWORD });
console.log("\nСессия сохранена в data/cookie.txt. Чтобы обновить её на сервере, отправь боту в личку:\n");
console.log(`/session ${cookie}\n`);
