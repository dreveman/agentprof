// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";

import {
  CLOCK_PI_CUSTOM,
  TRACK_EVENT_BEGIN,
  TRACK_EVENT_COUNTER,
  TRACK_EVENT_INSTANT,
  buildClockSnapshot,
  buildTracePacket,
  buildTrackDescriptor,
  buildTrackEvent,
  encodeFixed64,
  encodeVarint,
  framePacket,
} from "./encoder.ts";

describe("pi-tracing encoder wire vectors", () => {
  test("varint(300) == AC 02", () => {
    expect(encodeVarint(300)).toEqual([0xac, 0x02]);
  });

  test("varint zero and small values", () => {
    expect(encodeVarint(0)).toEqual([0x00]);
    expect(encodeVarint(1)).toEqual([0x01]);
    expect(encodeVarint(127)).toEqual([0x7f]);
    expect(encodeVarint(128)).toEqual([0x80, 0x01]);
  });

  test("varint 64-bit via bigint", () => {
    // 2^40 -> 5 bytes, MSB-set on all but last.
    const bytes = encodeVarint(1n << 40n);
    expect(bytes.length).toBe(6);
    expect(bytes[bytes.length - 1]! & 0x80).toBe(0);
  });

  test("fixed64 little-endian", () => {
    expect(encodeFixed64(1)).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(encodeFixed64(0x0102030405060708n)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });

  test("instant event carries type/track/name/category", () => {
    const event = buildTrackEvent({
      trackUuid: 42n,
      categories: ["pi.agent"],
      name: "turn",
      type: TRACK_EVENT_INSTANT,
    });
    // type field 9 varint 3 -> tag 0x48, value 0x03
    expect(event[0]).toBe(0x48);
    expect(event[1]).toBe(TRACK_EVENT_INSTANT);
    expect(event.length).toBeGreaterThan(8);
  });

  test("counter event requires a value", () => {
    expect(() =>
      buildTrackEvent({ trackUuid: 7n, categories: ["pi.runtime"], type: TRACK_EVENT_COUNTER }),
    ).toThrow();
    const event = buildTrackEvent({
      trackUuid: 7n,
      categories: ["pi.runtime"],
      name: "rss",
      type: TRACK_EVENT_COUNTER,
      counterValue: 1234n,
    });
    expect(event.length).toBeGreaterThan(0);
  });

  test("slice begin/end share track uuid encoding", () => {
    const begin = buildTrackEvent({ trackUuid: 9n, categories: ["pi.tools"], name: "bash", type: TRACK_EVENT_BEGIN });
    const end = buildTrackEvent({ trackUuid: 9n, categories: [], type: 2 });
    // track_uuid field 11 varint -> tag 0x58, value 0x09 in both.
    expect([...begin].includes(0x58)).toBe(true);
    expect([...end].includes(0x58)).toBe(true);
  });

  test("flow ids encode as repeated fixed64 field 47", () => {
    const withFlow = buildTrackEvent({
      trackUuid: 5n,
      categories: ["pi.tools"],
      name: "preflight",
      type: TRACK_EVENT_INSTANT,
      flowIds: [0x0102030405060708n],
    });
    // field 47 fixed64 -> tag varint (47 << 3) | 1 = 377 = 0xF9 0x02, then 8 LE bytes.
    const bytes = [...withFlow];
    const tagIndex = bytes.indexOf(0xf9);
    expect(tagIndex).toBeGreaterThanOrEqual(0);
    expect(bytes[tagIndex + 1]).toBe(0x02);
    expect(bytes.slice(tagIndex + 2, tagIndex + 10)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(() =>
      buildTrackEvent({ trackUuid: 5n, categories: [], type: TRACK_EVENT_INSTANT, flowIds: [0n] }),
    ).toThrow();
  });

  test("framed packet starts with Trace.packet field-1 tag (0x0A)", () => {
    const event = buildTrackEvent({
      trackUuid: 11n,
      categories: ["pi.agent"],
      name: "x",
      type: TRACK_EVENT_INSTANT,
    });
    const packet = buildTracePacket({
      timestampNs: 1000n,
      clockId: CLOCK_PI_CUSTOM,
      seqId: 1234,
      trackEvent: event,
    });
    const framed = framePacket(packet);
    expect(framed[0]).toBe(0x0a);
    expect(framed.length).toBeGreaterThan(packet.length);
  });

  test("packet encodes nonzero machine id as uint32 field 98", () => {
    const packet = buildTracePacket({
      seqId: 1,
      machineId: 1,
      clockSnapshot: new Uint8Array(),
    });
    // seq id field 10, machine id field 98 (tag 0x90 0x06), empty snapshot.
    expect([...packet]).toEqual([0x50, 0x01, 0x90, 0x06, 0x01, 0x32, 0x00]);
    expect([
      ...buildTracePacket({
        seqId: 1,
        machineId: 0,
        clockSnapshot: new Uint8Array(),
      }),
    ]).toEqual([0x50, 0x01, 0x32, 0x00]);
  });

  test("packet requires nonzero seq id and exactly one payload", () => {
    const event = buildTrackEvent({
      trackUuid: 11n,
      categories: ["pi.agent"],
      type: TRACK_EVENT_INSTANT,
    });
    expect(() =>
      buildTracePacket({ timestampNs: 1n, clockId: CLOCK_PI_CUSTOM, seqId: 0, trackEvent: event }),
    ).toThrow();
    const descriptor = buildTrackDescriptor({ uuid: 99n, name: "t" });
    expect(() =>
      buildTracePacket({
        timestampNs: 1n,
        clockId: CLOCK_PI_CUSTOM,
        seqId: 5,
        trackEvent: event,
        trackDescriptor: descriptor,
      }),
    ).toThrow();
  });

  test("descriptor rejects reserved uuid 0", () => {
    expect(() => buildTrackDescriptor({ uuid: 0n })).toThrow();
  });

  test("clock snapshot encodes two clocks", () => {
    const snapshot = buildClockSnapshot(
      [
        { clockId: CLOCK_PI_CUSTOM, timestampNs: 5000n },
        { clockId: 1, timestampNs: 6000n },
      ],
      1,
    );
    expect(snapshot.length).toBeGreaterThan(0);
    // primary_trace_clock field 2, varint wire type => trailing tag 0x10/value 1.
    expect([...snapshot.slice(-2)]).toEqual([0x10, 0x01]);
  });
});
