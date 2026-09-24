import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const FILE = `${process.env.DATA_DIR || "data"}/state.json`;

export function loadState() {
  if (!existsSync(FILE)) return { bootstrapped: false, tasks: {}, sessionAlerted: false };
  return JSON.parse(readFileSync(FILE, "utf8"));
}

export function saveState(state) {
  writeFileSync(FILE + ".tmp", JSON.stringify(state, null, 2));
  renameSync(FILE + ".tmp", FILE);
}
