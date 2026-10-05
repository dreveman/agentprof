// SPDX-License-Identifier: Apache-2.0
// A regression check for common leaks; published recordings still need manual review.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';
import {decodeFields, tracePackets} from '../packages/pi-tracing/extensions/pi-tracing/test-proto.ts';

export function privacyFindings(text: string): string[] {
  const findings = new Set<string>();
  for (const match of text.matchAll(/[\w.+%-]+@([\w.-]+\.[a-zA-Z]{2,})/g)) {
    if (!/^(?:example\.(?:com|org|net)|users\.noreply\.github\.com)$/.test(match[1]!)) {
      findings.add('email address');
    }
  }
  for (const match of text.matchAll(/(?:\/(?:home|Users)\/|[A-Z]:\\+Users\\+)([\w.-]+)/g)) {
    if (!['example', 'user', 'runner'].includes(match[1]!)) findings.add('personal home directory');
  }
  if (/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----)/.test(text)) {
    findings.add('credential pattern');
  }
  if (/\b(?:authorization["']?\s*[:=]\s*["']?\s*bearer|(?:api[_-]?key|access[_-]?token)["']?\s*[:=]\s*["'][A-Za-z0-9_/-]{16})/i.test(text)) {
    findings.add('credential assignment');
  }
  return [...findings];
}

export function tracePrivacyFindings(bytes: Uint8Array, depth = 0): string[] {
  assert.ok(depth < 8, 'Unexpected compressed trace nesting');
  // These patterns remain visible in protobuf string fields. Also inspect any
  // compressed packet streams, which a strings/grep-only check would miss.
  const findings = new Set<string>();
  for (const packet of tracePackets(bytes)) {
    for (const field of decodeFields(packet)) {
      if (!field.bytes) continue;
      const matches = field.number === 50
        ? tracePrivacyFindings(inflateSync(field.bytes, {maxOutputLength: 64 * 1024 * 1024}), depth + 1)
        : privacyFindings(Buffer.from(field.bytes).toString('utf8'));
      for (const finding of matches) findings.add(finding);
    }
  }
  return [...findings];
}

if (import.meta.main) {
  const files = execFileSync('git', ['ls-files', '-z'], {encoding: 'utf8'}).split('\0').filter(Boolean);
  let traces = 0;
  const failures: string[] = [];
  for (const file of files) {
    let findings: string[];
    if (file.endsWith('.pftrace')) {
      findings = tracePrivacyFindings(readFileSync(file));
      traces++;
    } else if (file.endsWith('example_trace.ts')) {
      const match = readFileSync(file, 'utf8').match(/BASE64 = '([^']+)'/);
      assert.ok(match, `Missing bundled trace in ${file}`);
      findings = tracePrivacyFindings(Buffer.from(match[1]!, 'base64'));
      traces++;
    } else if (file.startsWith('examples/') || file.startsWith('third_party/patches/')) {
      findings = privacyFindings(readFileSync(file, 'utf8'));
    } else continue;
    // Report locations and categories without echoing potentially private data.
    if (findings.length) failures.push(`${file}: ${findings.join(', ')}`);
  }
  assert.ok(traces > 0, 'No tracked example traces found');
  assert.deepEqual(failures, [], 'Review private data before publishing examples');
  console.log(`PASS example privacy: ${traces} source/bundled traces, example files and patch headers`);
}
