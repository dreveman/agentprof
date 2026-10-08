// SPDX-License-Identifier: Apache-2.0
import {test, expect} from 'bun:test';
import {linuxProcessStartMarker, pidExists, processStartMarker, sameProcess} from './process-identity.ts';

function stat(command: string, marker: string) {
  return `42 (${command}) ${Array.from({length: 20}, (_, index) => index === 19 ? marker : '0').join(' ')} 0`;
}

test('Linux start marker ignores spaces and closing parentheses in process names', () => {
  expect(linuxProcessStartMarker(stat('worker (busy) pool', '987654'))).toBe('987654');
  expect(linuxProcessStartMarker('not a stat record')).toBeUndefined();
  expect(processStartMarker(42, 'darwin', () => {throw new Error('should not read');})).toBeUndefined();
  expect(processStartMarker(42, 'linux', () => stat('worker', '123'))).toBe('123');
});

test('PID liveness treats EPERM as alive and rejects recycled generations', () => {
  const denied = () => {throw Object.assign(new Error('denied'), {code: 'EPERM'});};
  expect(pidExists(42, denied)).toBe(true);
  expect(pidExists(0, () => {throw new Error('called');})).toBe(false);
  expect(sameProcess(42, 'start-a', () => true, () => 'start-b')).toBe(false);
  expect(sameProcess(42, 'start-a', () => true, () => 'start-a')).toBe(true);
  expect(sameProcess(42, 'start-a', () => true, () => undefined)).toBe(true);
  expect(sameProcess(42, undefined, () => true)).toBe(true);
  expect(sameProcess(42, undefined, () => false)).toBe(false);
});
