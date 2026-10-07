// SPDX-License-Identifier: Apache-2.0
// Summarize half-open [start, end) intervals in milliseconds.
export function summarizeIntervals(intervals) {
  return {
    activeMs: intervals.reduce((sum, [start, end]) => sum + end - start, 0),
    peakConcurrency: intervals.length,
  };
}
