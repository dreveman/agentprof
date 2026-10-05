import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeIntervals} from './intervals.mjs';

test('simultaneous starts/ends', () => {
  assert.deepEqual(summarizeIntervals([[0, 5], [0, 5], [5, 9]]), {activeMs: 9, peakConcurrency: 2});
});

test('duplicated intervals', () => {
  assert.deepEqual(summarizeIntervals([[1, 4], [1, 4], [1, 4]]), {activeMs: 3, peakConcurrency: 3});
});

test('zero-length intervals', () => {
  assert.deepEqual(summarizeIntervals([[2, 2], [5, 5], [0, 3]]), {activeMs: 3, peakConcurrency: 1});
});

test('frozen input', () => {
  const input = Object.freeze([Object.freeze([0, 4]), Object.freeze([2, 6])]);
  assert.deepEqual(summarizeIntervals(input), {activeMs: 6, peakConcurrency: 2});
});
