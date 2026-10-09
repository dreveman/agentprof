// SPDX-License-Identifier: Apache-2.0
// Node 16 has no Array.findLast; keep lookups local to the recorder.
export function findLast<T>(values: readonly T[] | undefined, predicate: (value: T) => boolean): T | undefined {
  if (!values) return;
  for (let index = values.length - 1; index >= 0; index--) {
    const value = values[index]!;
    if (predicate(value)) return value;
  }
}
