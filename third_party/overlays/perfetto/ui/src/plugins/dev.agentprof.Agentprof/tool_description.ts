// SPDX-License-Identifier: Apache-2.0

// Argument keys come from the harness; keep the recorded spelling and values.
export function toolDescription(intent: string | undefined, argumentsJson: string | undefined,
                                script?: {language?: string; lineCount?: number; truncated?: boolean}): string | undefined {
  if (intent?.trim()) return intent.trim();
  const args: Record<string, string> = argumentsJson === undefined ? {} : JSON.parse(argumentsJson);
  if (script) {
    const language = script.language?.trim() || 'Script';
    let lines = script.lineCount;
    let partial = false;
    if (lines === undefined || !Number.isSafeInteger(lines) || lines < 0) {
      const source = args.code ?? args.script;
      if (typeof source !== 'string') return language;
      lines = source.length === 0 ? 0 : source.split(/\r\n|\r|\n/).length - (/[\r\n]$/.test(source) ? 1 : 0);
      partial = script.truncated === true;
    }
    return `${language} · ${partial ? '≥' : ''}${lines} ${lines === 1 ? 'line' : 'lines'}`;
  }
  const text = (...keys: string[]): string | undefined => keys.map(key => args[key])
    .find(value => typeof value === 'string' && value.trim().length > 0);
  const command = text('command');
  if (command) return command;
  const path = text('path', 'file_path', 'file');
  const oldText = text('oldText', 'old_string');
  const newText = text('newText', 'new_string');
  if (oldText || newText) return [path,
    oldText && `− ${oldText}`, newText && `+ ${newText}`].filter(Boolean).join('\n');
  const code = text('code', 'script');
  if (code) return code;
  const pattern = text('pattern');
  if (pattern) return path ? `${pattern} in ${path}` : pattern;
  if (path) {
    const details = ['offset', 'limit'].filter(key => args[key] !== undefined)
      .map(key => `${key} ${args[key]}`);
    const content = text('content');
    return [path, ...details].join(' · ') + (content ? `\n${content}` : '');
  }
  return Object.entries(args).map(([key, value]) => `${key}: ${value}`).join(' · ') || undefined;
}
