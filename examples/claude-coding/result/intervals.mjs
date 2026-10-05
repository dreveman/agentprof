// Summarize half-open [start, end) intervals in milliseconds.
export function summarizeIntervals(intervals) {
  if (intervals.length === 0) {
    return { activeMs: 0, peakConcurrency: 0 };
  }

  // Sort by start time, then by end time descending (to handle nesting)
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || b[1] - a[1]);

  // Merge overlapping intervals
  const merged = [];
  for (const [start, end] of sorted) {
    if (merged.length === 0) {
      merged.push([start, end]);
    } else {
      const [lastStart, lastEnd] = merged[merged.length - 1];
      if (start <= lastEnd) {
        // Overlapping or touching, merge
        merged[merged.length - 1][1] = Math.max(lastEnd, end);
      } else {
        // Gap, add new interval
        merged.push([start, end]);
      }
    }
  }

  // Calculate active duration from merged intervals
  const activeMs = merged.reduce((sum, [start, end]) => sum + (end - start), 0);

  // Calculate peak concurrency using sweep algorithm
  const events = [];
  for (const [start, end] of intervals) {
    events.push([start, 1]); // start event
    events.push([end, -1]); // end event
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // sort by time, starts before ends

  let current = 0;
  let peakConcurrency = 0;
  for (const [, delta] of events) {
    current += delta;
    peakConcurrency = Math.max(peakConcurrency, current);
  }

  return { activeMs, peakConcurrency };
}
