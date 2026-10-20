// Runs jobs (functions returning promises) at most `concurrency` at a time,
// in the order they came in. A failed job frees its slot like a finished one.
export function queue(concurrency) {
  let running = 0;
  const waiting = [];
  const next = () => {
    if (running >= concurrency || !waiting.length) return;
    running++;
    const job = waiting.shift();
    Promise.resolve()
      .then(job)
      .catch(() => {})
      .finally(() => {
        running--;
        next();
      });
  };
  return (job) => {
    waiting.push(job);
    next();
  };
}
