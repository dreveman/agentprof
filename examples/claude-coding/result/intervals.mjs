// Summarize half-open [start, end) intervals in milliseconds.
export function summarizeIntervals(intervals) {
  if (intervals.length === 0) {
    return { activeMs: 0, peakConcurrency: 0 };
  }

  // Create events for each interval start/end, sorted by time
  const events = [];
  for (const [start, end] of intervals) {
    events.push([start, 1]);  // start event
    events.push([end, -1]);   // end event
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // ends before starts at same time

  let activeMs = 0;
  let peakConcurrency = 0;
  let concurrency = 0;
  let lastTime = null;

  for (const [time, type] of events) {
    if (lastTime !== null && lastTime !== time && concurrency > 0) {
      activeMs += time - lastTime;
    }
    concurrency += type;
    if (concurrency > 0) {
      peakConcurrency = Math.max(peakConcurrency, concurrency);
    }
    lastTime = time;
  }

  return { activeMs, peakConcurrency };
}
