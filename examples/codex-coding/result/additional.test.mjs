import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeIntervals} from './intervals.mjs';

test('simultaneous starts and ends do not overlap', () => {
  assert.deepEqual(summarizeIntervals([[0, 4], [4, 7], [4, 9]]), {
    activeMs: 9,
    peakConcurrency: 2,
  });
});

test('duplicated intervals count separately for concurrency', () => {
  assert.deepEqual(summarizeIntervals([[1, 5], [1, 5]]), {
    activeMs: 4,
    peakConcurrency: 2,
  });
});

test('zero-length intervals do not affect the union or concurrency', () => {
  assert.deepEqual(summarizeIntervals([[2, 2], [0, 3]]), {
    activeMs: 3,
    peakConcurrency: 1,
  });
});

test('accepts frozen input without mutation', () => {
  const input = Object.freeze([Object.freeze([0, 5]), Object.freeze([3, 8])]);
  assert.deepEqual(summarizeIntervals(input), {
    activeMs: 8,
    peakConcurrency: 2,
  });
});
