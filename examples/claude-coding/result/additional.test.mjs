// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeIntervals} from './intervals.mjs';

test('simultaneous starts and ends', () => {
  const intervals = [[0, 5], [0, 5], [0, 5]];
  assert.deepEqual(summarizeIntervals(intervals), {activeMs: 5, peakConcurrency: 3});
});

test('duplicated intervals', () => {
  const intervals = [[1, 3], [1, 3], [5, 7], [5, 7]];
  assert.deepEqual(summarizeIntervals(intervals), {activeMs: 4, peakConcurrency: 2});
});

test('zero-length intervals', () => {
  const intervals = [[0, 0], [5, 5], [10, 10], [2, 4]];
  assert.deepEqual(summarizeIntervals(intervals), {activeMs: 2, peakConcurrency: 1});
});

test('frozen input', () => {
  const intervals = Object.freeze([Object.freeze([1, 3]), Object.freeze([2, 5]), Object.freeze([4, 6])]);
  assert.deepEqual(summarizeIntervals(intervals), {activeMs: 5, peakConcurrency: 2});
});
