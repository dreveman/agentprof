import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeIntervals} from './intervals.mjs';

test('simultaneous starts and ends', () => {
  const intervals = [[0, 3], [0, 3], [0, 3]];
  assert.deepEqual(summarizeIntervals(intervals), {activeMs: 3, peakConcurrency: 3});
});

test('duplicated intervals', () => {
  const intervals = [[1, 5], [1, 5], [7, 10], [7, 10]];
  assert.deepEqual(summarizeIntervals(intervals), {activeMs: 7, peakConcurrency: 2});
});

test('zero-length intervals', () => {
  const intervals = [[3, 3], [5, 5], [0, 2], [4, 7]];
  assert.deepEqual(summarizeIntervals(intervals), {activeMs: 5, peakConcurrency: 1});
});

test('frozen input', () => {
  const input = Object.freeze([
    Object.freeze([1, 4]),
    Object.freeze([2, 6]),
    Object.freeze([5, 8])
  ]);
  assert.deepEqual(summarizeIntervals(input), {activeMs: 7, peakConcurrency: 2});
});
