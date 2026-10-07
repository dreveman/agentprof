// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeIntervals} from './intervals.mjs';

for (const [name, intervals, expected] of [
  ['empty', [], {activeMs: 0, peakConcurrency: 0}],
  ['single', [[2, 5]], {activeMs: 3, peakConcurrency: 1}],
  ['overlap', [[0, 5], [3, 8]], {activeMs: 8, peakConcurrency: 2}],
  ['touching endpoints', [[0, 5], [5, 9]], {activeMs: 9, peakConcurrency: 1}],
  ['unsorted and nested', [[6, 7], [0, 10], [3, 8]], {activeMs: 10, peakConcurrency: 3}],
  ['gaps and zero length', [[0, 2], [8, 8], [5, 7]], {activeMs: 4, peakConcurrency: 1}],
  ['fractional', [[0.5, 2.5], [1.5, 3]], {activeMs: 2.5, peakConcurrency: 2}],
]) {
  test(name, () => assert.deepEqual(summarizeIntervals(intervals), expected));
}
test('does not mutate input', () => {
  const input = Object.freeze([Object.freeze([6, 9]), Object.freeze([0, 3])]);
  assert.deepEqual(summarizeIntervals(input), {activeMs: 6, peakConcurrency: 1});
});
