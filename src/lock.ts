/**
 * A cross-process advisory lock.
 *
 * Every Raycast command is a separate OS process with no shared memory, so two
 * commands can perform a read-modify-write on the same download id at the same
 * moment. An in-process mutex (a promise chain, a boolean) cannot see the other
 * process at all; it makes the code LOOK synchronized while the data still
 * gets lost.
 *
 * The only synchronization primitive available to both processes is the
 * filesystem they already share, so this is built from `open(path, "wx")` —
 * the same atomic create-or-fail that `uniquePath({reserve:true})` uses. It is
 * the lowest-dependency lock that actually crosses a process boundary, which
 * matters because `dist/runner.bundle.js` has to bundle standalone.
 *
 * Two properties are non-negotiable, both learned from lock files that outlive
 * their owner:
 *
 *   - **Recoverable.** A runner SIGKILLed mid-write leaves the lock file
 *     behind. A lock that is never stealable would wedge every later download
 *     forever, so a lock whose owner is gone (identified by both pid and
 *     start time when available) and whose mtime is older than `staleMs` is
 *     stolen. When process identity cannot be verified, mtime alone remains
 *     the recovery signal; async holders keep it fresh with a heartbeat.
 *   - **Never fatal.** If the lock cannot be taken within `waitMs` (a wedged
 *     filesystem, a permission problem), the critical section runs ANYWAY,
 *     unsynchronized. Losing a history row is bad; refusing to download is
 *     worse. Callers get correctness in every reachable case and degrade to
 *     the pre-lock behaviour in the unreachable ones.
 */

import { execFileSync } from "node:child_process";
import { closeSync, futimesSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface FileLockOptions {
  /** Steal a lock whose file is older than this. Default 10s. */
  staleMs?: number;
  /** Give up waiting and run unsynchronized after this long. Default 5s. */
  waitMs?: number;
  /** Poll interval while waiting. Default 15ms. */
  pollMs?: number;
}

/**
 * Locks this process currently holds, by path, with a depth count.
 *
 * Reentrancy is required rather than nice: `acquireLease` takes the status lock
 * and then calls `writeStatus`, which takes the same lock. Without a depth
 * count that is a guaranteed self-deadlock on every lease acquisition.
 */
const syncHeld = new Map<string, number>();

/** Async callers have no legitimate reentrancy; serialize them per pathname. */
const asyncTails = new Map<string, Promise<void>>();

let tokenSequence = 0;
let ownStartTimeResolved = false;
let ownStartTimeMs: number | undefined;

interface LockLease {
  fd: number;
  token: string;
}

interface LockOwner {
  pid?: number;
  token: string;
  startedAtMs?: number;
}

/** Shared buffer for `Atomics.wait`, the only dependency-free synchronous sleep. */
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function newToken(): string {
  tokenSequence += 1;
  return `${process.pid}-${Date.now().toString(36)}-${tokenSequence}-${Math.random().toString(36).slice(2)}`;
}

function readOwner(lockPath: string): LockOwner | undefined {
  try {
    const contents = readFileSync(lockPath, "utf8").trim();
    // A crash can happen after `open("wx")` but before the first write. Give
    // that legacy empty lock a stable synthetic identity so stale recovery
    // still works instead of wedging forever.
    if (!contents) return { token: "legacy:" };
    const [pidText, token, startedAtText] = contents.split(/\s+/, 3);
    const pid = Number(pidText);
    const startedAtMs = Number(startedAtText);
    // One-field locks are from older versions. Keeping them recoverable also
    // lets an interrupted upgrade clear its old stale lock.
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
      token: token ?? `legacy:${contents}`,
      startedAtMs: Number.isFinite(startedAtMs) && startedAtMs > 0 ? startedAtMs : undefined,
    };
  } catch {
    return undefined;
  }
}

function stillOwnedBy(lockPath: string, token: string): boolean {
  return readOwner(lockPath)?.token === token;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Process start time in epoch ms, or undefined when the platform cannot prove
 * it. This intentionally duplicates status.ts: importing that module would
 * create a lock/status require cycle.
 */
function processStartTimeMs(pid: number): number | undefined {
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Subtract([datetime]'1970-01-01').TotalMilliseconds`,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
      ).trim();
      const ms = Number.parseFloat(out);
      if (Number.isFinite(ms) && ms > 0) return Math.floor(ms);
    } catch {
      // Fall through to WMIC.
    }

    try {
      const out = execFileSync("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/value"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trim();
      const match = /CreationDate=(\d{14})\.(\d{6})([+-]\d+)/.exec(out);
      if (!match) return undefined;

      const [, stamp, micros, offsetMinutes] = match;
      const asUtc = Date.UTC(
        Number(stamp.slice(0, 4)),
        Number(stamp.slice(4, 6)) - 1,
        Number(stamp.slice(6, 8)),
        Number(stamp.slice(8, 10)),
        Number(stamp.slice(10, 12)),
        Number(stamp.slice(12, 14)),
        Math.floor(Number(micros) / 1000),
      );
      return asUtc - Number(offsetMinutes) * 60_000;
    } catch {
      return undefined;
    }
  }

  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return undefined;
    const parsed = Date.parse(out);
    return Number.isNaN(parsed) ? undefined : parsed;
  } catch {
    return undefined;
  }
}

function currentProcessStartTimeMs(): number | undefined {
  if (!ownStartTimeResolved) {
    ownStartTimeMs = processStartTimeMs(process.pid);
    ownStartTimeResolved = true;
  }
  return ownStartTimeMs;
}

/** True only when a live pid can also be matched to the recorded process. */
function ownerIsStillAlive(owner: LockOwner): boolean {
  if (owner.pid === undefined || owner.startedAtMs === undefined || !processIsAlive(owner.pid)) return false;
  const actual = processStartTimeMs(owner.pid);
  // `ps -o lstart` reports whole seconds, matching status.ts's tolerance.
  return actual !== undefined && Math.abs(actual - owner.startedAtMs) < 2000;
}

/** True when the lock file was created and still carries this lease's token. */
function tryTake(lockPath: string): LockLease | undefined {
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    const fd = openSync(lockPath, "wx", 0o600);
    const token = newToken();
    try {
      // Process identity, not a bare pid, participates in stale recovery. The
      // random per-acquire token prevents a former owner deleting a replacement.
      const startedAtMs = currentProcessStartTimeMs();
      writeSync(fd, `${process.pid} ${token}${startedAtMs === undefined ? "" : ` ${startedAtMs}`}\n`);
    } catch {
      closeSync(fd);
      return undefined;
    }
    if (stillOwnedBy(lockPath, token)) return { fd, token };
    closeSync(fd);
    return undefined;
  } catch {
    return undefined;
  }
}

/** Remove a lock file whose owner is long gone. */
function stealIfStale(lockPath: string, staleMs: number): void {
  try {
    const owner = readOwner(lockPath);
    if (Date.now() - statSync(lockPath).mtimeMs <= staleMs) return;
    // A matching live identity protects a lock even if a heartbeat was missed.
    // Missing or unverifiable identity (including pre-start-time lock files)
    // deliberately falls back to mtime so a recycled bare pid cannot wedge it.
    if (!owner || ownerIsStillAlive(owner)) return;
    // The pathname can have been released and retaken between the first read
    // and stat. Only remove the same owner we observed.
    if (stillOwnedBy(lockPath, owner.token)) unlinkSync(lockPath);
  } catch {
    // Gone already, or not ours to remove — the caller retries either way.
  }
}

function touch(lease: LockLease): void {
  try {
    // Touch the inode held by this fd, never whichever file later appeared at
    // the same pathname.
    const now = new Date();
    futimesSync(lease.fd, now, now);
  } catch {
    // The lock can still be released by token below.
  }
}

function release(lockPath: string, lease: LockLease): void {
  try {
    // Never unlink a successor that stole or replaced our pathname.
    if (stillOwnedBy(lockPath, lease.token)) unlinkSync(lockPath);
  } catch {
    // Gone already, or replaced while we were checking ownership.
  } finally {
    try {
      closeSync(lease.fd);
    } catch {
      // Already closed.
    }
  }
}

/** Run `fn` while holding `lockPath`. Synchronous, for the status-file writers. */
export function withFileLockSync<T>(lockPath: string, fn: () => T, options: FileLockOptions = {}): T {
  const { staleMs = 10_000, waitMs = 5_000, pollMs = 15 } = options;

  const depth = syncHeld.get(lockPath);
  if (depth !== undefined) {
    syncHeld.set(lockPath, depth + 1);
    try {
      return fn();
    } finally {
      const current = syncHeld.get(lockPath) ?? 1;
      if (current <= 1) syncHeld.delete(lockPath);
      else syncHeld.set(lockPath, current - 1);
    }
  }

  const deadline = Date.now() + waitMs;
  let lease = tryTake(lockPath);
  while (lease === undefined && Date.now() < deadline) {
    stealIfStale(lockPath, staleMs);
    lease = tryTake(lockPath);
    if (lease === undefined) sleepSync(pollMs);
  }

  // Timed out: run anyway. See the header — a wedged lock must not become a
  // refusal to download.
  if (lease === undefined) return fn();

  syncHeld.set(lockPath, 1);
  try {
    return fn();
  } finally {
    syncHeld.delete(lockPath);
    release(lockPath, lease);
  }
}

/**
 * Run `fn` while holding `lockPath`, without blocking the event loop.
 *
 * History mutations are async (Raycast's LocalStorage is a promise API), so
 * they must not spin the thread the way `withFileLockSync` does.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const previous = asyncTails.get(lockPath) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => withFileLockAsync(lockPath, fn, options));
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  asyncTails.set(lockPath, tail);
  void tail.finally(() => {
    if (asyncTails.get(lockPath) === tail) asyncTails.delete(lockPath);
  });
  return run;
}

async function withFileLockAsync<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions,
): Promise<T> {
  const { staleMs = 10_000, waitMs = 5_000, pollMs = 15 } = options;

  const deadline = Date.now() + waitMs;
  let lease = tryTake(lockPath);
  while (lease === undefined && Date.now() < deadline) {
    stealIfStale(lockPath, staleMs);
    lease = tryTake(lockPath);
    if (lease === undefined) await new Promise((r) => setTimeout(r, pollMs));
  }

  if (lease === undefined) return fn();

  const heartbeat = setInterval(() => touch(lease!), Math.max(1, Math.floor(staleMs / 3)));
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    release(lockPath, lease);
  }
}
