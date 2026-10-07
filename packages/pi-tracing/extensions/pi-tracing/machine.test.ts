// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";

import {
  fnv1a64,
  machineIdFromBootId,
  machineIdFromDigest,
  resolveMachineIdentity,
} from "./machine.ts";

const unavailable = (): never => {
  throw new Error("unavailable");
};

describe("pi-tracing machine identity", () => {
  test("matches Perfetto FNV-1a 64-bit vectors", () => {
    expect(fnv1a64("")).toBe(0xcbf29ce484222325n);
    expect(fnv1a64("a")).toBe(0xaf63dc4c8601ec8cn);
    expect(fnv1a64("foobar")).toBe(0x85944171f73967e8n);
  });

  test("uses the low 32 digest bits and reserves zero", () => {
    expect(machineIdFromDigest(0x85944171f73967e8n)).toBe(0xf73967e8);
    expect(machineIdFromDigest(0n)).toBe(1);
  });

  test("normalizes boot-id whitespace before hashing", () => {
    expect(machineIdFromBootId("a\n")).toBe(0x8601ec8c);
    expect(machineIdFromBootId("  \n")).toBe(0);
  });

  test("reads the Linux kernel boot id", () => {
    const identity = resolveMachineIdentity("linux", {
      readTextFile(path) {
        expect(path).toBe("/proc/sys/kernel/random/boot_id");
        return "11111111-1111-1111-1111-111111111111\n";
      },
      readSysctl: unavailable,
    });
    expect(identity).toEqual({ id: 0x40d24ca1, source: "linux-boot-id" });
  });

  test("reads the macOS boot session UUID", () => {
    const identity = resolveMachineIdentity("darwin", {
      readTextFile: unavailable,
      readSysctl(name) {
        expect(name).toBe("kern.bootsessionuuid");
        return "00000000-0000-0000-0000-000000000000\n";
      },
    });
    expect(identity).toEqual({ id: 0x18f299f1, source: "darwin-boot-session" });
  });

  test("falls back to the implicit host when boot identity is unavailable", () => {
    expect(
      resolveMachineIdentity("linux", {
        readTextFile: unavailable,
        readSysctl: unavailable,
      }),
    ).toEqual({ id: 0, source: "unavailable" });
    expect(
      resolveMachineIdentity("freebsd", {
        readTextFile: unavailable,
        readSysctl: unavailable,
      }),
    ).toEqual({ id: 0, source: "unavailable" });
  });
});
