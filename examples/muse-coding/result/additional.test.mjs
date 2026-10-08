// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeIntervals} from './intervals.mjs';

test('simultaneous starts/ends', () => {
  assert.deepEqual(
    summarizeIntervals([[0, 5], [5, 9], [5, 5]]),
    {activeMs: 9, peakConcurrency: 1},
  );
});

test('duplicated intervals', () => {
  assert.deepEqual(
    summarizeIntervals([[1, 4], [1, 4], [1, 4]]),
    {activeMs: 3, peakConcurrency: 3},
  );
});

test('zero-length intervals', () => {
  assert.deepEqual(
    summarizeIntervals([[2, 2], [7, 7]]),
    {activeMs: 0, peakConcurrency: 0},
  );
});

test('frozen input', () => {
  const input = Object.freeze([Object.freeze([0, 3]), Object.freeze([1, 2])]);
  assert.deepEqual(summarizeIntervals(input), {activeMs: 3, peakConcurrency: 2});
  assert.deepEqual(input, [[0, 3], [1, 2]]);
});
