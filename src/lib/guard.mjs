const OWN_COMMANDS = new Set(["start", "help", "deadlines", "chatid", "session"]);

// Decides what to do with an incoming command: `remove` deletes the message,
// `run` lets the handler answer. Mutates `lastRun` (key → timestamp).
//
// In the group, commands typed outside the deadlines topic are removed (the
// answer still goes to the topic), repeats within the cooldown are removed and
// ignored, and /session is always removed because it carries the LMS cookie.
export function guardCommand(msg, lastRun, cfg) {
  const m = msg.text?.match(/^\/([a-z_]+)(?:@(\w+))?(?:\s|$)/i);
  if (!m) return null;
  const command = m[1].toLowerCase();
  if (!OWN_COMMANDS.has(command)) return null;
  if (m[2] && m[2].toLowerCase() !== cfg.botUsername.toLowerCase()) return null;

  const inGroup = String(msg.chatId) === cfg.chatId;
  if (!inGroup && msg.chatType !== "private") return { command, remove: false, run: true };
  if (command === "session") return { command, remove: inGroup, run: !inGroup };

  const key = inGroup ? `group:${command}` : `user:${msg.userId}:${command}`;
  const cooldown = inGroup ? cfg.groupCooldownMs : cfg.privateCooldownMs;
  const onCooldown = msg.now - (lastRun.get(key) ?? -Infinity) < cooldown;
  if (!onCooldown) lastRun.set(key, msg.now);

  const outsideTopic = inGroup && cfg.threadId && msg.threadId !== Number(cfg.threadId);
  return { command, remove: inGroup && (outsideTopic || onCooldown), run: !onCooldown };
}
