// SPDX-License-Identifier: Apache-2.0
// Summarize half-open [start, end) intervals in milliseconds.
export function summarizeIntervals(intervals) {
  if (intervals.length === 0) {
    return { activeMs: 0, peakConcurrency: 0 };
  }

  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);

  let activeMs = 0;
  let peakConcurrency = 0;
  let mergeStart = sorted[0][0];
  let mergeEnd = sorted[0][1];

  for (let i = 1; i < sorted.length; i++) {
    const [start, end] = sorted[i];
    if (start <= mergeEnd) {
      mergeEnd = Math.max(mergeEnd, end);
    } else {
      activeMs += mergeEnd - mergeStart;
      mergeStart = start;
      mergeEnd = end;
    }
  }
  activeMs += mergeEnd - mergeStart;

  const events = [];
  for (const [start, end] of intervals) {
    events.push([start, 1]);
    events.push([end, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  let current = 0;
  for (const [, delta] of events) {
    current += delta;
    peakConcurrency = Math.max(peakConcurrency, current);
  }

  return { activeMs, peakConcurrency };
}
