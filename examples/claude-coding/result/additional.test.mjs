// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeIntervals} from './intervals.mjs';

test('simultaneous starts and ends', () => {
  const intervals = [[0, 3], [0, 3], [0, 3]];
  assert.deepEqual(summarizeIntervals(intervals), {activeMs: 3, peakConcurrency: 3});
});

test('duplicated intervals', () => {
  const intervals = [[1, 4], [1, 4], [2, 5], [2, 5]];
  assert.deepEqual(summarizeIntervals(intervals), {activeMs: 4, peakConcurrency: 4});
});

test('zero-length intervals', () => {
  const intervals = [[2, 2], [5, 5], [1, 3]];
  assert.deepEqual(summarizeIntervals(intervals), {activeMs: 2, peakConcurrency: 1});
});

test('frozen input', () => {
  const intervals = Object.freeze([Object.freeze([1, 5]), Object.freeze([2, 4]), Object.freeze([6, 8])]);
  assert.deepEqual(summarizeIntervals(intervals), {activeMs: 6, peakConcurrency: 2});
});
