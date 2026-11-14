// SPDX-License-Identifier: Apache-2.0
// Difference of one session metric relative to a baseline session. Sessions
// may be completely different tasks, so a delta only describes the two
// recordings; it is never a verdict about which run was better.

export type DeltaKind = 'duration' | 'tokens' | 'count' | 'rate' | 'share';
export type DeltaMode = 'both' | 'percent' | 'off';

export interface Delta {
  difference: number;
  /** Signed percent of |baseline|; undefined when the baseline is 0. */
  percent?: number;
}

function numeric(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

export function computeDelta(value: unknown, baseline: unknown): Delta | undefined {
  const current = numeric(value), base = numeric(baseline);
  if (current === undefined || base === undefined) return undefined;
  const difference = current - base;
  return {difference, percent: base !== 0 ? difference / Math.abs(base) * 100 : undefined};
}

const sign = (n: number) => n > 0 ? '+' : n < 0 ? '−' : '';
const grouped = (n: number) => Math.abs(n).toLocaleString('en-US', {maximumFractionDigits: 0});

function formatAbsolute(difference: number, kind: DeltaKind): string {
  const prefix = sign(difference), amount = Math.abs(difference);
  if (kind === 'duration') {
    return prefix + (amount >= 1000 ? `${(amount / 1000).toFixed(2)} s` : `${amount.toFixed(1)} ms`);
  }
  if (kind === 'share') return `${prefix}${(amount * 100).toFixed(1)} pts`;
  if (kind === 'rate') return `${prefix}${amount.toLocaleString('en-US', {maximumFractionDigits: 1})}`;
  return prefix + grouped(Math.round(amount));
}

function formatPercent(percent: number): string {
  const amount = Math.abs(percent);
  const text = amount >= 10 ? String(Math.round(amount)) : amount.toFixed(1).replace(/\.0$/, '');
  return `${sign(percent)}${text}%`;
}

/** Human-readable delta, or undefined when either side was not recorded. */
export function deltaText(value: unknown, baseline: unknown, kind: DeltaKind,
                          mode: DeltaMode = 'both'): string | undefined {
  if (mode === 'off') return undefined;
  const delta = computeDelta(value, baseline);
  if (delta === undefined) return undefined;
  if (delta.difference === 0) return '±0';
  // Context share is itself a percentage; its absolute delta (points) is the
  // clearest form, so percent-only mode still shows points for it.
  if (kind === 'share') {
    return mode === 'both' && delta.percent !== undefined
      ? `${formatAbsolute(delta.difference, kind)} (${formatPercent(delta.percent)})`
      : formatAbsolute(delta.difference, kind);
  }
  if (mode === 'percent') {
    return delta.percent === undefined ? formatAbsolute(delta.difference, kind)
      : formatPercent(delta.percent);
  }
  return delta.percent === undefined ? formatAbsolute(delta.difference, kind)
    : `${formatAbsolute(delta.difference, kind)} (${formatPercent(delta.percent)})`;
}
