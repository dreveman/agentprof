// SPDX-License-Identifier: Apache-2.0
// Summarize half-open [start, end) intervals in milliseconds.
export function summarizeIntervals(intervals) {
  const events = [];

  for (const [start, end] of intervals) {
    if (start === end) continue;
    events.push([start, 1], [end, -1]);
  }

  events.sort((a, b) => a[0] - b[0]);

  let activeMs = 0;
  let peakConcurrency = 0;
  let concurrency = 0;
  let previousTime;

  for (let i = 0; i < events.length;) {
    const time = events[i][0];
    if (previousTime !== undefined && concurrency > 0) {
      activeMs += time - previousTime;
    }

    let change = 0;
    while (i < events.length && events[i][0] === time) {
      change += events[i][1];
      i++;
    }
    concurrency += change;
    peakConcurrency = Math.max(peakConcurrency, concurrency);
    previousTime = time;
  }

  return {activeMs, peakConcurrency};
}
