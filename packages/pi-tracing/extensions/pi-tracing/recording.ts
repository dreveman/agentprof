// One recording owns private per-process spools. Descendants inherit its
// directory; only the owner publishes a user-facing trace file.
import {existsSync} from 'node:fs';
import {link, lstat, mkdir, open, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {mergePiTraces, type MergeInput} from './merge.ts';

export class Recording {
  private cancelled = false;
  cancelPublication(): void {this.cancelled = true;}
  private constructor(readonly directory: string, readonly output: string, readonly owner: boolean) {}
  static async create(outDir: string, base: string, outputPath?: string): Promise<Recording> {
    const directory = join(outDir, '.recordings', base);
    const output = outputPath ?? join(outDir, `${base}.pftrace`);
    await mkdir(dirname(output), {recursive: true});
    for (const candidate of [output, `${output}.part`]) {
      try {
        await lstat(candidate);
        throw new Error(`trace already exists: ${candidate}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await mkdir(directory, {recursive: true, mode: 0o700});
    await writeFile(join(directory, 'recording.json'), JSON.stringify({output}), {mode: 0o600, flag: 'wx'});
    await writeFile(join(directory, 'active'), '', {mode: 0o600, flag: 'wx'});
    return new Recording(directory, output, true);
  }
  static async join(directory: string): Promise<Recording> {
    const {output} = JSON.parse(await readFile(join(directory, 'recording.json'), 'utf8'));
    if (typeof output !== 'string' || !existsSync(join(directory, 'active'))) throw new Error('parent recording has stopped');
    return new Recording(directory, output, false);
  }
  active(): boolean {return existsSync(join(this.directory, 'active'));}
  async close(): Promise<void> {if (this.owner) await rm(join(this.directory, 'active'), {force: true});}

  async publish(ownerFile: string, maxBytes: number, deadlineAt: number) {
    const checkDeadline = () => {
      if (this.cancelled || Date.now() >= deadlineAt) throw new Error('recording merge deadline exceeded');
    };
    await this.close();
    // Give running children time to observe stop, close spans and flush. Never
    // wait for their agent tasks to finish. Busy/crashed writers are snapshotted.
    const waitUntil = Math.min(deadlineAt - 150, Date.now() + 250);
    let names: string[] = [];
    const ready = (files: string[]) => !files.some(n => n.endsWith('.pftrace.part')) &&
      files.filter(n => n.endsWith('.pftrace')).every(n => files.includes(`${n}.json`));
    do {
      names = await readdir(this.directory);
      if (ready(names) || Date.now() >= waitUntil) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (true);
    const inputs: MergeInput[] = [];
    let size = 0;
    for (const name of names.filter(n => n.endsWith('.pftrace') || n.endsWith('.pftrace.part'))
      .sort((a, b) => a === basename(ownerFile) ? -1 : b === basename(ownerFile) ? 1 : a.localeCompare(b))) {
      let handle;
      let partial = name.endsWith('.part');
      try {handle = await open(join(this.directory, name), 'r');} catch (error) {
        // The child may atomically publish between directory scan and open.
        if (!partial || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        handle = await open(join(this.directory, name.replace(/\.part$/, '')), 'r');
        partial = false;
      }
      try {
        const length = (await handle.stat()).size;
        size += length;
        if (size > maxBytes) throw new Error('combined recording exceeds maxFileMB');
        const bytes = Buffer.alloc(length);
        let offset = 0;
        while (offset < length) {
          checkDeadline();
          const {bytesRead} = await handle.read(bytes, offset, length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset > 0) inputs.push({bytes: bytes.subarray(0, offset), incomplete: partial});
      } finally {await handle.close();}
    }
    const merged = mergePiTraces(inputs, {maxBytes, deadlineAt});
    checkDeadline();
    const temp = `${this.output}.part`;
    const handle = await open(temp, 'wx', 0o600);
    try {await handle.writeFile(merged.bytes); checkDeadline(); await handle.sync();} finally {await handle.close();}
    checkDeadline();
    // A requested output path must never replace an existing recording. The
    // temp file is in the same directory, so a hard link publishes atomically
    // with exclusive creation even if another writer races the start check.
    await link(temp, this.output);
    await rm(temp).catch(() => {});
    // Retain spools for an incomplete snapshot or late writers; never delete
    // a file another process may still be writing. Completed groups need none.
    names = await readdir(this.directory);
    if (!this.cancelled && !merged.incomplete && ready(names)) await rm(this.directory, {recursive: true, force: true});
    return merged;
  }
}
