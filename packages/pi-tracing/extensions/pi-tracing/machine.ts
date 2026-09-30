import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FNV1A_64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV1A_64_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;
const UINT32_MASK = 0xffffffffn;
const utf8 = new TextEncoder();

export type MachineIdentitySource =
  | "linux-boot-id"
  | "darwin-boot-session"
  | "unavailable";

export interface MachineIdentity {
  /** Perfetto TracePacket.machine_id. Zero means the field must be omitted. */
  id: number;
  source: MachineIdentitySource;
}

export interface MachineIdentityDependencies {
  readTextFile(path: string): string;
  readSysctl(name: string): string;
}

const defaultDependencies: MachineIdentityDependencies = {
  readTextFile(path) {
    return readFileSync(path, "utf8");
  },
  readSysctl(name) {
    return execFileSync("/usr/sbin/sysctl", ["-n", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    });
  },
};

/** Perfetto's base::FnvHasher: FNV-1a over UTF-8 bytes with 64-bit wraparound. */
export function fnv1a64(value: string): bigint {
  let digest = FNV1A_64_OFFSET_BASIS;
  for (const byte of utf8.encode(value)) {
    digest ^= BigInt(byte);
    digest = (digest * FNV1A_64_PRIME) & UINT64_MASK;
  }
  return digest;
}

/** Perfetto machine IDs are the low 32 bits of the 64-bit digest; zero is
 * reserved for the implicit host machine and is remapped to one. */
export function machineIdFromDigest(digest: bigint): number {
  const id = Number(digest & UINT32_MASK);
  return id === 0 ? 1 : id;
}

export function machineIdFromBootId(rawBootId: string): number {
  const bootId = rawBootId.trim();
  return bootId === "" ? 0 : machineIdFromDigest(fnv1a64(bootId));
}

/** Resolve a boot-scoped identity shared by every Pi process on one machine.
 * Linux deliberately mirrors Perfetto/Kineto. macOS uses the kernel's boot
 * session UUID. Failure falls back to machine id zero (field omitted), just as
 * the Perfetto SDK does for an unattributed host producer. */
export function resolveMachineIdentity(
  platform: NodeJS.Platform = process.platform,
  dependencies: MachineIdentityDependencies = defaultDependencies,
): MachineIdentity {
  try {
    if (platform === "linux") {
      const id = machineIdFromBootId(
        dependencies.readTextFile("/proc/sys/kernel/random/boot_id"),
      );
      return id === 0
        ? { id: 0, source: "unavailable" }
        : { id, source: "linux-boot-id" };
    }
    if (platform === "darwin") {
      const id = machineIdFromBootId(
        dependencies.readSysctl("kern.bootsessionuuid"),
      );
      return id === 0
        ? { id: 0, source: "unavailable" }
        : { id, source: "darwin-boot-session" };
    }
  } catch {
    // Preserve a valid single-machine trace when boot identity is unavailable.
  }
  return { id: 0, source: "unavailable" };
}

let cachedMachineIdentity: MachineIdentity | undefined;

/** Resolve once per process, matching PerfettoTraceLogger's process-lifetime
 * machine identity and avoiding repeated filesystem/subprocess work. */
export function currentMachineIdentity(): MachineIdentity {
  cachedMachineIdentity ??= resolveMachineIdentity();
  return cachedMachineIdentity;
}
