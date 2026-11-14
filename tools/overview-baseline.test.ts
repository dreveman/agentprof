// SPDX-License-Identifier: Apache-2.0
import {expect, test} from 'bun:test';
import {computeDelta, deltaText} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/baseline.ts';

test('deltas describe the difference without inventing missing values', () => {
  expect(computeDelta(150, 100)).toEqual({difference: 50, percent: 50});
  expect(computeDelta(40, 100)).toEqual({difference: -60, percent: -60});
  expect(computeDelta(null, 100)).toBeUndefined();
  expect(computeDelta(100, undefined)).toBeUndefined();
  expect(computeDelta('n/a', 100)).toBeUndefined();
  expect(deltaText(null, 100, 'tokens')).toBeUndefined();
});

test('zero baselines show absolute differences only', () => {
  expect(computeDelta(5, 0)).toEqual({difference: 5, percent: undefined});
  expect(deltaText(5, 0, 'count')).toBe('+5');
  expect(deltaText(5, 0, 'count', 'percent')).toBe('+5');
  expect(deltaText(100, 100, 'tokens')).toBe('±0');
});

test('delta formatting follows the metric kind and display mode', () => {
  expect(deltaText(1500, 1000, 'tokens')).toBe('+500 (+50%)');
  expect(deltaText(1500, 1000, 'tokens', 'percent')).toBe('+50%');
  expect(deltaText(1500, 1000, 'tokens', 'off')).toBeUndefined();
  expect(deltaText(2500, 4000, 'duration')).toBe('−1.50 s (−38%)');
  expect(deltaText(12.5, 10, 'rate')).toBe('+2.5 (+25%)');
  expect(deltaText(0.5, 0.25, 'share')).toBe('+25.0 pts (+100%)');
  expect(deltaText(0.5, 0.25, 'share', 'percent')).toBe('+25.0 pts');
});
