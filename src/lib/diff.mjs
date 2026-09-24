// Compares a fresh task list with what the bot has already announced and
// returns what to post. Mutates `state.tasks` so the caller only has to save it.
export function diff(state, tasks, now, remindHours) {
  const events = { added: [], moved: [], reminders: new Map() };
  const seen = new Set();

  for (const task of tasks) {
    const key = String(task.id);
    seen.add(key);
    const hoursLeft = (Date.parse(task.deadline) - now) / 3_600_000;
    // Thresholds already behind us count as sent: a task published 20h before
    // its deadline gets a "new task" post, not a late "3 days left" one.
    const passed = remindHours.filter((h) => hoursLeft <= h);
    const prev = state.tasks[key];

    if (!prev) {
      state.tasks[key] = { deadline: task.deadline, sent: passed };
      if (state.bootstrapped) events.added.push(task);
      continue;
    }

    if (prev.deadline !== task.deadline) {
      events.moved.push({ task, from: prev.deadline });
      state.tasks[key] = { deadline: task.deadline, sent: passed };
      continue;
    }

    const due = remindHours.filter((h) => hoursLeft <= h && !prev.sent.includes(h));
    if (due.length === 0) continue;
    // Several thresholds can be crossed at once after downtime; only the
    // tightest one is worth posting.
    const h = Math.min(...due);
    if (!events.reminders.has(h)) events.reminders.set(h, []);
    events.reminders.get(h).push(task);
    prev.sent.push(...due);
  }

  for (const key of Object.keys(state.tasks)) if (!seen.has(key)) delete state.tasks[key];
  state.bootstrapped = true;
  return events;
}
