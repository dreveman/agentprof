// SPDX-License-Identifier: Apache-2.0
// Minimal protobuf reader for wire-level recording assertions.
interface ProtoField {
  number: number;
  wire: number;
  value?: bigint;
  bytes?: Uint8Array;
}

function decodeVarint(bytes: Uint8Array, offset: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  for (let i = offset; i < bytes.length && i < offset + 10; i++) {
    const byte = bytes[i];
    if (byte === undefined) break;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
    shift += 7n;
  }
  throw new Error("invalid protobuf varint");
}

export function decodeFields(bytes: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = decodeVarint(bytes, offset);
    offset = tag.next;
    const number = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (wire === 0) {
      const value = decodeVarint(bytes, offset);
      offset = value.next;
      fields.push({ number, wire, value: value.value });
    } else if (wire === 1) {
      const value = new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true);
      offset += 8;
      fields.push({ number, wire, value });
    } else if (wire === 2) {
      const length = decodeVarint(bytes, offset);
      offset = length.next;
      const end = offset + Number(length.value);
      if (end > bytes.length) throw new Error("truncated protobuf field");
      fields.push({ number, wire, bytes: bytes.slice(offset, end) });
      offset = end;
    } else if (wire === 5) {
      offset += 4;
      fields.push({ number, wire });
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return fields;
}

export function tracePackets(trace: Uint8Array): Uint8Array[] {
  return decodeFields(trace).map((field) => {
    if (field.number !== 1 || field.wire !== 2 || field.bytes === undefined) {
      throw new Error("trace contains a non-Trace.packet top-level field");
    }
    return field.bytes;
  });
}
