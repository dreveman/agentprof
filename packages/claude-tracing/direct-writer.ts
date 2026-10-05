// SPDX-License-Identifier: Apache-2.0
import {initializeDirectCapture, finishDirectCapture} from './direct-journal.ts';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const [command, path] = process.argv.slice(2);
try {
  if (!['init', 'finish', 'finalize', 'worker'].includes(command ?? '') || (command !== 'init' && !path))
    throw new Error('Usage: direct-writer.mjs init [OUTPUT] | finish CAPTURE_DIRECTORY');
  if (command === 'finalize' || command === 'finish') {
    // A one-shot converter can finish after Claude's short session.end deadline.
    // No collector or long-lived service is needed.
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'worker', path!], {detached: true, windowsHide: true, stdio: 'ignore'});
    await new Promise<void>((resolve, reject) => {child.once('spawn', resolve); child.once('error', reject);});
    if (command === 'finalize') {
      child.unref();
      console.log(JSON.stringify({saving: true}));
    } else {
      // The manual control waits, but its converter also survives interruption.
      const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
      if (code !== 0) throw new Error(readFileSync(join(path!, 'error.txt'), 'utf8').trim());
      console.log(readFileSync(join(path!, 'summary.json'), 'utf8'));
    }
  } else console.log(JSON.stringify(command === 'init' ? initializeDirectCapture(path) : finishDirectCapture(path!)));
} catch (error) {
  if (command === 'worker' && path) {
    try {writeFileSync(join(path, 'error.txt'), String(error) + '\n', {mode: 0o600});} catch {}
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
