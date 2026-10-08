// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeIntervals} from './intervals.mjs';

test('simultaneous starts and ends are half-open', () => {
  assert.deepEqual(summarizeIntervals([[0, 2], [0, 1], [1, 3], [2, 4]]), {
    activeMs: 4,
    peakConcurrency: 2,
  });
});

test('duplicated intervals count independently for concurrency', () => {
  assert.deepEqual(summarizeIntervals([[1, 5], [1, 5]]), {
    activeMs: 4,
    peakConcurrency: 2,
  });
});

test('zero-length intervals do not contribute', () => {
  assert.deepEqual(summarizeIntervals([[2, 2], [4, 4]]), {
    activeMs: 0,
    peakConcurrency: 0,
  });
});

test('supports frozen input', () => {
  const intervals = Object.freeze([
    Object.freeze([0, 3]),
    Object.freeze([2, 5]),
  ]);
  assert.deepEqual(summarizeIntervals(intervals), {activeMs: 5, peakConcurrency: 2});
});
