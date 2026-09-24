// Deploy steps printed at the end of `bun run setup`. Every target needs the
// same three things: run the Dockerfile (or `bun src/bot.mjs`), pass the
// variables from deploy.env, keep /app/data on a persistent volume.
// `bun run deploy` shows them again without redoing the setup.
import { existsSync, readFileSync } from "node:fs";
import * as p from "@clack/prompts";

export const TARGETS = [
  { value: "panel", label: "Coolify, Dokploy или другая панель с Docker", hint: "собирает Dockerfile из GitHub" },
  { value: "compose", label: "Свой сервер с Docker Compose" },
  { value: "docker", label: "Свой сервер с Docker, без Compose" },
  { value: "systemd", label: "Свой сервер без Docker", hint: "Bun + systemd" },
  { value: "local", label: "Пока только на этом компьютере" },
];

const VOLUME_WHY = "Без него бот после перезапуска забудет, о чём уже писал,\n   и потеряет обновлённую сессию LMS.";
const ONE_INSTANCE = "Бот с одним токеном может работать только в одном месте: локальную копию останови.";

export function deployGuide(target, { repo, bot }) {
  const dir = "deadline-radar-cu";
  const guides = {
    panel: [
      "1. Создай приложение из Git-репозитория:",
      `   ${repo}`,
      "   (свой форк или «Public repository», ветка main).",
      "2. Способ сборки: Dockerfile. Порт и домен не нужны: бот сам ходит в Telegram.",
      "3. Добавь постоянный том (Persistent Storage) с путём /app/data.",
      `   ${VOLUME_WHY}`,
      "4. Вставь содержимое deploy.env в переменные окружения",
      "   (в Coolify: Environment Variables → Developer view).",
      "5. Задеплой и открой логи: должна появиться строка",
      `   «@${bot} started».`,
    ],
    compose: [
      "На сервере:",
      `  git clone ${repo} ${dir}`,
      "",
      "С этого компьютера отправь настройки:",
      `  scp deploy.env user@server:~/${dir}/.env`,
      "",
      "На сервере:",
      `  cd ${dir} && docker compose up -d --build`,
      "  docker compose logs -f",
      "",
      "Данные бота лежат в томе Docker. Обновление:",
      "  git pull && docker compose up -d --build",
    ],
    docker: [
      "На сервере:",
      `  git clone ${repo} ${dir} && cd ${dir}`,
      "  docker build -t deadline-radar .",
      "",
      "С этого компьютера отправь настройки:",
      `  scp deploy.env user@server:~/${dir}/deploy.env`,
      "",
      "На сервере:",
      "  docker run -d --name deadline-radar --restart unless-stopped \\",
      "    --env-file deploy.env -v deadline-radar-data:/app/data deadline-radar",
      "  docker logs -f deadline-radar",
    ],
    systemd: [
      "На сервере:",
      "  curl -fsSL https://bun.sh/install | bash",
      `  git clone ${repo} /opt/${dir} && cd /opt/${dir}`,
      "  bun install --production",
      "",
      "С этого компьютера отправь настройки:",
      `  scp deploy.env root@server:/opt/${dir}/.env`,
      "",
      "Создай /etc/systemd/system/deadline-radar.service:",
      "  [Unit]",
      "  Description=Deadline Radar",
      "  After=network-online.target",
      "  [Service]",
      `  WorkingDirectory=/opt/${dir}`,
      "  ExecStart=/root/.bun/bin/bun src/bot.mjs",
      "  Restart=always",
      "  [Install]",
      "  WantedBy=multi-user.target",
      "",
      "И запусти:",
      "  systemctl enable --now deadline-radar",
      "  journalctl -u deadline-radar -f",
    ],
    local: [
      "  bun start",
      "",
      "Бот работает, пока открыт терминал и компьютер не спит.",
      "Когда будешь готов перенести его на сервер, запусти",
      "bun run deploy: deploy.env уже готов.",
    ],
  };
  const lines = guides[target];
  if (target !== "local") {
    lines.push("", ONE_INSTANCE, "Серверу нужен доступ к api.telegram.org и my.centraluniversity.ru.");
  }
  return lines.join("\n");
}

export function repoUrl() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  return pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
}

export async function showDeployGuide(opts) {
  const target = await p.select({
    message: "Где будет работать бот?",
    options: TARGETS.map(({ value, label, hint }) => ({ value, label, hint })),
  });
  if (p.isCancel(target)) return false;
  p.note(deployGuide(target, opts), "Как запустить");
  return true;
}

if (import.meta.main) {
  if (!existsSync("deploy.env")) {
    console.error("Нет deploy.env: сначала запусти bun run setup");
    process.exit(1);
  }
  const token = readFileSync("deploy.env", "utf8").match(/^BOT_TOKEN=(.+)$/m)?.[1];
  const { Api } = await import("grammy");
  const bot = token ? await new Api(token).getMe().then((me) => me.username).catch(() => "your_bot") : "your_bot";
  p.intro(" Deadline Radar · запуск на сервере ");
  if (await showDeployGuide({ repo: repoUrl(), bot })) p.outro("Готово. Проверить: отправь /deadlines в группе.");
}
