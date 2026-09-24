import { existsSync, readFileSync, writeFileSync } from "node:fs";

const BASE = "https://my.centraluniversity.ru/api/micro-lms";
const DATA_DIR = process.env.DATA_DIR || "data";
const COOKIE_FILE = `${DATA_DIR}/cookie.txt`;
const SEED_FILE = `${DATA_DIR}/cookie-seed.txt`;
const SESSION_FILE = `${DATA_DIR}/session.json`;

export class SessionExpiredError extends Error {}

// The BFF keeps OIDC tokens server-side behind a single `bff.cookie` and
// re-issues it with a fresh 14-day max-age on every response, so persisting the
// latest value keeps the session alive as long as the bot polls regularly.
function loadCookie() {
  // CU_COOKIE bootstraps a server that never ran `login`. It wins only when it
  // changed since last start, so a stale env value can't clobber a cookie the
  // bot has been refreshing on disk.
  const seed = process.env.CU_COOKIE;
  if (seed && (!existsSync(SEED_FILE) || readFileSync(SEED_FILE, "utf8") !== seed)) {
    writeFileSync(SEED_FILE, seed, { mode: 0o600 });
    writeFileSync(COOKIE_FILE, seed, { mode: 0o600 });
    return seed;
  }
  if (existsSync(COOKIE_FILE)) return readFileSync(COOKIE_FILE, "utf8").trim();
  if (existsSync(SESSION_FILE)) {
    const { cookies } = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    const bff = cookies.find((c) => c.name === "bff.cookie");
    if (bff) return bff.value;
  }
  return null;
}

let cookie = loadCookie();

export function setCookie(value) {
  cookie = value;
  writeFileSync(COOKIE_FILE, cookie, { mode: 0o600 });
}

export function saveCookieFromSession() {
  if (existsSync(COOKIE_FILE)) writeFileSync(COOKIE_FILE, "");
  cookie = loadCookie();
  if (cookie) writeFileSync(COOKIE_FILE, cookie, { mode: 0o600 });
}

async function get(path, params = {}) {
  if (!cookie) throw new SessionExpiredError("no session, run `pnpm login`");
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { cookie: `bff.cookie=${cookie}` } });

  for (const header of res.headers.getSetCookie()) {
    const m = header.match(/^bff\.cookie=([^;]+)/);
    if (m && m[1] !== cookie) setCookie(m[1]);
  }

  if (res.status === 401) throw new SessionExpiredError("LMS session expired, run `pnpm login`");
  if (!res.ok) throw new Error(`LMS ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export const getMe = () => get("/students/me");

// /deadlines drops tasks the account owner already submitted, which is wrong
// for a group feed, so read every task and keep the ones still ahead.
export async function getUpcomingTasks() {
  const tasks = await get("/tasks/student", { limit: 1000 });
  const now = Date.now();
  return tasks
    .filter((t) => t.deadline && Date.parse(t.deadline) > now && !t.course.isArchived)
    .map((t) => ({
      id: t.exercise.id,
      name: t.exercise.name.trim(),
      course: t.course.name.trim(),
      url: `https://my.centraluniversity.ru/learn/courses/view/actual/${t.course.id}/themes/${t.theme.id}/longreads/${t.longread.id}`,
      activity: t.exercise.activity?.name,
      deadline: t.deadline,
    }))
    .sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline));
}
