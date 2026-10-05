// SPDX-License-Identifier: Apache-2.0
import {CONTEXT_CATEGORIES, type ContextSnapshot} from '../pi-tracing/extensions/pi-tracing/context.ts';
import type {Counter, Slice} from './trace.ts';

// Attach observations to real operations. Never fabricate intervals for snapshots.
export function attachContext(slice: Slice, snapshot: ContextSnapshot, counters: Counter[], at = slice.start) {
  slice.attrs.context = {...snapshot, sample_offset_ns: Number(at - slice.start)} as unknown as NonNullable<typeof slice.attrs[string]>;
  for (const [key, value] of Object.entries(snapshot.categories)) {
    const name = CONTEXT_CATEGORIES[key as keyof typeof CONTEXT_CATEGORIES] ?? key;
    let counter = counters.find(c => c.session === slice.session && c.name === `Context: ${name}`);
    if (!counter) {counter = {session: slice.session, name: `Context: ${name}`, group: 'Context', unit: 'tokens', axis: 'llm.context.tokens', samples: []}; counters.push(counter);}
    counter.samples.push({at, value});
  }
  // A vanished category must stop occupying the chart and timeline.
  for (const c of counters.filter(c => c.session === slice.session && c.group === 'Context'))
    if (!Object.keys(snapshot.categories).some(key => c.name === `Context: ${CONTEXT_CATEGORIES[key as keyof typeof CONTEXT_CATEGORIES] ?? key}`)) c.samples.push({at, value: 0});
}
