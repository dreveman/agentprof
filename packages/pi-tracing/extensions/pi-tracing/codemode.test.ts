// SPDX-License-Identifier: Apache-2.0
import {expect, test} from 'bun:test';
import {CodemodeCalls} from './codemode.ts';
import type {Recorder} from './tracer.ts';

test('content-enabled codemode still sees model calls after long ordinary prefixes', () => {
  const calls = Array.from({length: 4096}, (_, i) => ({id: `ordinary-${i}`, name: 'read', status: 'ok'}));
  const begins: string[] = [], ends: Record<string, unknown>[] = [];
  const recorder = {trackSet: () => ({used: new Set<bigint>()}), addBeginFlow() {},
    beginToolSlice: (_id: string, name: string) => {begins.push(name); return 17;},
    emitEnd: (_id: number, attrs: Record<string, unknown>) => {ends.push(attrs);}} as unknown as Recorder;
  const parser = new CodemodeCalls();
  parser.observe(recorder, 'parent', 1, {details: {calls: [...calls,
    {id: 'model', name: 'models.classify', status: 'running'}]}}, false, true);
  parser.observe(recorder, 'parent', 1, {details: {calls: [...calls,
    {id: 'model', name: 'models.classify', status: 'ok'}]}}, true, true);
  expect(begins).toEqual(['models.classify']);
  expect(ends).toEqual([{status: 'ok', is_error: false}]);
});

test('content-disabled codemode snapshots examine at most 4096 call identities', () => {
  let inspected = 0;
  const calls = new Proxy(new Array(1_000_000), {
    getOwnPropertyDescriptor(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        inspected++;
        if (Number(key) >= 4096) throw new Error('unbounded scan');
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const parser = new CodemodeCalls();
  parser.observe({} as Recorder, 'parent', 1, {details: {calls}}, false, false);
  expect(inspected).toBe(4096);
  let read = false;
  parser.observe({} as Recorder, 'parent', 1, {get details() {read = true; throw new Error('getter');}}, true, false);
  expect(read).toBe(false);
});
