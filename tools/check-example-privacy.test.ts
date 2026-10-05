// SPDX-License-Identifier: Apache-2.0
import {expect, test} from 'bun:test';
import {deflateSync} from 'node:zlib';
import {encodeBytesField, framePacket, buildTrackEvent, buildTracePacket} from '../packages/pi-tracing/extensions/pi-tracing/encoder.ts';
import {privacyFindings, tracePrivacyFindings} from './check-example-privacy.ts';

test('rejects private details but permits documented placeholders and public repo names', () => {
  expect(privacyFindings('author@private.invalid /home/person/project C:\\Users\\person\\project')).toEqual([
    'email address', 'personal home directory',
  ]);
  expect(privacyFindings('/workspace/intervals /home/example/task /user/.config author@example.com github.com/dreveman/agentprof')).toEqual([]);
  expect(privacyFindings('ghp_' + 'a'.repeat(36))).toEqual(['credential pattern']);
  expect(privacyFindings('-----BEGIN ' + 'PRIVATE KEY-----')).toEqual(['credential pattern']);
  expect(privacyFindings('Authorization: Bearer example')).toEqual(['credential assignment']);
  expect(privacyFindings(JSON.stringify({api_key: 'a'.repeat(32)}))).toEqual(['credential assignment']);
});

test('checks nested tool arguments and compressed protobuf packets', () => {
  const packet = buildTracePacket({seqId: 1, timestampNs: 1n, clockId: 1, trackEvent: buildTrackEvent({
    trackUuid: 1n, type: 1, categories: ['test.activity'],
    debugAnnotations: {args: {command: 'cat /home/person/private.txt'}},
  })});
  const trace = framePacket(packet);
  expect(tracePrivacyFindings(trace)).toEqual(['personal home directory']);
  const compressed = framePacket(Uint8Array.from(encodeBytesField(50, deflateSync(trace))));
  expect(tracePrivacyFindings(compressed)).toEqual(['personal home directory']);
  expect(() => tracePrivacyFindings(new Uint8Array([255]))).toThrow();
});
