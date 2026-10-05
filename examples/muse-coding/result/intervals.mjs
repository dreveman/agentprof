// Summarize half-open [start, end) intervals in milliseconds.
export function summarizeIntervals(intervals) {
  const events = [];
  for (const [start, end] of intervals) {
    if (end > start) {
      events.push([start, 1], [end, -1]);
    }
  }
  if (events.length === 0) return {activeMs: 0, peakConcurrency: 0};
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let activeMs = 0;
  let active = 0;
  let peak = 0;
  let prev = events[0][0];
  for (const [time, delta] of events) {
    if (active > 0) activeMs += time - prev;
    active += delta;
    if (active > peak) peak = active;
    prev = time;
  }
  return {activeMs, peakConcurrency: peak};
}
