/**
 * The status file: how a detached transfer reports to a command that may not
 * exist yet.
 *
 * Raycast unloads a command on Escape, so progress cannot live in memory. The
 * runner writes JSON to disk; any later command instance reads it. That makes
 * this the coordination point between processes, and every rule below exists
 * because a naive implementation loses or corrupts data:
 *
 *  - Writes are atomic (tmp + rename). A reader must never see half-written JSON.
 *  - Liveness is `(pid, startedAtMs)`, never a bare pid. macOS `kern.maxproc` is
 *    16000; a recycled pid would let Cancel kill an unrelated process.
 *  - `heartbeatAt` (process alive) and `lastByteAt` (bytes moving) are separate.
 *    Conflated, a hung-but-alive transfer reads as healthy forever.
 *  - Adoption takes a lease. Two Raycast windows must not both resume the same
 *    download and write the same file.
 *  - Every read-modify-write of a status file holds a cross-process lock. A
 *    command reading `downloading`, the runner writing `completed`, then the
 *    command writing its stale snapshot back is a LOST COMPLETION, and the two
 *    are separate OS processes, so no in-process mutex can see it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { withFileLockSync } from "./lock";
import { writeSecretFile } from "./paths";

export type DownloadState = "starting" | "generating" | "downloading" | "finalizing" | "completed" | "failed" | "cancelled";

/** States from which no further transition happens without user action. */
const TERMINAL: ReadonlySet<DownloadState> = new Set<DownloadState>(["completed", "failed", "cancelled"]);

export function isTerminal(state: DownloadState): boolean {
  return TERMINAL.has(state);
}

export interface DownloadStatus {
  /** Bumped only on incompatible shape changes; readers reject unknown versions. */
  schema: 1;
  id: string;
  /** Process group leader of the detached runner. `process.kill(-pid)` targets the group. */
  pid: number;
  /**
   * Runner start time, epoch ms. Together with `pid` this identifies the process:
   * a recycled pid necessarily has a later start time than the one recorded here.
   */
  startedAtMs: number;
  state: DownloadState;
  filename: string;
  outputPath: string;
  /** Where bytes land until the transfer is verified. Retained on failure for `curl -C -`. */
  partPath: string;
  bytesDownloaded: number;
  totalBytes?: number;
  speedBytesPerSec?: number;
  etaSeconds?: number;
  /** Process-alive signal. Advances even when no bytes move. */
  heartbeatAt: number;
  /** Bytes-moving signal. Stall detection keys off this, never off `heartbeatAt`. */
  lastByteAt?: number;
  startedAt: number;
  finishedAt?: number;
  error?: { code: string; message: string; httpStatus?: number };
  /**
   * Which command instance currently owns this download, and until when.
   * Adoption is a compare-and-swap on this field.
   */
  ownerId?: string;
  leaseUntil?: number;
  /**
   * Opaque per-consumer payload. Deliberately NOT the source URL: signed URLs are
   * bearer credentials. Store an identifier here and re-resolve instead.
   */
  meta?: Record<string, unknown>;
}

/**
 * Directory holding status files.
 *
 * Prefers Raycast's `environment.supportPath`. Never `tmpdir()` — macOS purges
 * it while long transfers are still running.
 */
export function statusDir(override?: string): string {
  let base = override;
  if (!base) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { environment } = require("@raycast/api") as { environment?: { supportPath?: string } };
      base = environment?.supportPath;
    } catch {
      // Outside a Raycast host (tests, the runner): fall through.
    }
  }
  const dir = join(base ?? join(homedir(), ".raycast-downloader"), "downloads");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Reject an id that could escape the status directory.
 *
 * Ids reach `join()` to build file paths, so `"../../etc/foo"` would write
 * outside `statusDir`. A consumer that derives ids from remote content — a
 * filename, an API field — would hand an attacker a same-user file write, and a
 * signed URL could land somewhere unintended. Validating here means no consumer
 * has to know that.
 *
 * Deliberately a strict allowlist rather than a traversal blacklist: ids are
 * machine-generated (the default is a UUID), so there is no legitimate need for
 * separators, dots, or anything exotic.
 */
export function assertSafeId(id: string): void {
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id) || id.includes("..") || id.startsWith(".")) {
    throw new Error(
      `Invalid download id ${JSON.stringify(id)}. Ids may contain only letters, numbers, dot, dash and underscore, and may not contain "..".`,
    );
  }
}

export function statusPath(id: string, dir?: string): string {
  assertSafeId(id);
  return join(dir ?? statusDir(), `${id}.json`);
}

/**
 * The cross-process lock guarding one download's status file.
 *
 * A sibling of the status file rather than a single global lock: two unrelated
 * downloads finishing at the same moment must not serialize against each other.
 */
export function statusLockPath(id: string, dir?: string): string {
  return `${statusPath(id, dir)}.lock`;
}

/**
 * Run `fn` while holding a download's status lock.
 *
 * Exported so a caller that must read a status, decide something, and act on it
 * can do so without the runner changing the file underneath — `reconcileHistory`
 * deleting a status only if it is still the attempt it reconciled, for instance.
 */
export function withStatusLock<T>(id: string, dir: string | undefined, fn: () => T): T {
  return withFileLockSync(statusLockPath(id, dir), fn);
}

/**
 * Write atomically: a full file appears under the final name, or nothing does.
 * `renameSync` within one directory is atomic on macOS/APFS, so a concurrent
 * reader sees either the previous status or the new one — never a partial write.
 */
export function writeStatus(
  status: DownloadStatus,
  dir?: string,
  options: { clearLease?: boolean } = {},
): void {
  // Held across the read-and-write below, and reentrant so `acquireLease` can
  // hold the same lock around its own read-modify-write.
  withFileLockSync(statusLockPath(status.id, dir), () => writeStatusLocked(status, dir, options));
}

function writeStatusLocked(
  status: DownloadStatus,
  dir?: string,
  options: { clearLease?: boolean } = {},
): void {
  const target = statusPath(status.id, dir);

  // Preserve lease fields the writer doesn't know about.
  //
  // The runner keeps its own in-memory `status` and persists it every heartbeat.
  // That object never carries `ownerId`/`leaseUntil` — those are set by a
  // consumer via `acquireLease`. Writing it verbatim would erase a live lease
  // twice a second, letting a second window adopt a download the first already
  // owns. So lease fields survive unless the writer sets them itself, or asks
  // to clear them (which is how `releaseLease` gives one up — otherwise the
  // preservation below would make releasing impossible).
  const existing = readStatusFile(target);
  let next = status;
  if (!options.clearLease && status.ownerId === undefined && status.leaseUntil === undefined) {
    if (existing?.ownerId !== undefined) {
      next = { ...status, ownerId: existing.ownerId, leaseUntil: existing.leaseUntil };
    }
  }

  // The runner's periodic heartbeat is an in-memory snapshot. If cancellation
  // settled that same attempt while it was between heartbeats, letting that
  // snapshot write would resurrect a terminal download. A different process
  // identity is a deliberate Retry, so it remains free to reuse the id.
  if (
    existing &&
    isTerminal(existing.state) &&
    !isTerminal(next.state) &&
    existing.pid === next.pid &&
    existing.startedAtMs === next.startedAtMs
  ) {
    next = existing;
  }

  const tmp = `${target}.${process.pid}.tmp`;
  writeSecretFile(tmp, JSON.stringify(next));
  renameSync(tmp, target);
}

export function readStatus(id: string, dir?: string): DownloadStatus | null {
  return readStatusFile(statusPath(id, dir));
}

function readStatusFile(path: string): DownloadStatus | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DownloadStatus;
    // A file from a future version may not mean what this code thinks it means.
    if (
      parsed?.schema !== 1 ||
      typeof parsed.id !== "string" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      !Number.isFinite(parsed.startedAtMs) ||
      !TERMINAL.has(parsed.state) &&
        parsed.state !== "starting" &&
        parsed.state !== "generating" &&
        parsed.state !== "downloading" &&
        parsed.state !== "finalizing" ||
      typeof parsed.filename !== "string" ||
      typeof parsed.outputPath !== "string" ||
      typeof parsed.partPath !== "string" ||
      !Number.isFinite(parsed.bytesDownloaded) ||
      !Number.isFinite(parsed.heartbeatAt) ||
      !Number.isFinite(parsed.startedAt)
    ) {
      return null;
    }
    return parsed;
  } catch {
    // Missing, unreadable, or mid-rename — all "no status right now".
    return null;
  }
}

export function listStatuses(dir?: string): DownloadStatus[] {
  const directory = dir ?? statusDir();
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readStatusFile(join(directory, name)))
    .filter((status): status is DownloadStatus => status !== null);
}

export function clearStatus(id: string, dir?: string): void {
  try {
    unlinkSync(statusPath(id, dir));
  } catch {
    // Already gone.
  }
}

/**
 * True when the recorded process is still running *and* is the same process.
 *
 * `kill(pid, 0)` alone answers "does some process have this pid", which after
 * pid reuse is a different question from "is my runner alive".
 */
/**
 * How stale a heartbeat may be before a status counts as abandoned when process
 * identity cannot be verified. The runner heartbeats every 500ms, so 30s is
 * ~60 missed beats — far outside normal scheduling jitter or a brief GC pause.
 */
const HEARTBEAT_STALE_MS = 30_000;

export function isAlive(status: DownloadStatus, now = Date.now()): boolean {
  try {
    process.kill(status.pid, 0);
  } catch {
    return false;
  }

  // Is it OURS? A recycled pid belongs to something else, and signalling it
  // would kill an unrelated process.
  const actual = processStartTimeMs(status.pid);
  if (actual !== undefined) {
    // Tolerance because `ps` reports whole seconds.
    return Math.abs(actual - status.startedAtMs) < 2000;
  }

  // Start time unobtainable (unsupported platform, restricted environment).
  //
  // Reporting a LIVE download as dead is the more damaging error — it fails an
  // in-flight transfer while bytes keep arriving — so the bias is toward
  // "alive". But biasing unconditionally means a dead runner is never
  // reconciled, `pruneStatuses` never reaps its partial, and `watchStatus`
  // polls a stuck status forever. That just relocates the stuck-UI bug.
  //
  // So fall back to the one liveness signal that needs no process identity:
  // the runner's own heartbeat. A process that has not written in 30 seconds
  // is not running, whatever the pid table says.
  //
  // (Signalling still requires the strong check — see `killDownload`. Guessing
  // wrong here costs a mislabelled status; guessing wrong there kills an
  // unrelated process tree.)
  const lastSign = status.heartbeatAt ?? status.startedAt;
  return now - lastSign < HEARTBEAT_STALE_MS;
}

/** True when this platform can prove a pid belongs to the process we started. */
export function canVerifyProcessIdentity(): boolean {
  return processStartTimeMs(process.pid) !== undefined;
}

/**
 * Process start time in epoch ms, via `ps -o lstart`. Returns undefined when the
 * process is gone or unreadable.
 */
export function processStartTimeMs(pid: number): number | undefined {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");

  if (process.platform === "win32") {
    // PowerShell first: `wmic` is deprecated and absent from recent Windows 11
    // builds, so relying on it alone would silently disable identity checking on
    // current systems — and a silent fallback is exactly what this function
    // exists to avoid. Asking for a Unix-epoch value also sidesteps the
    // timezone-offset arithmetic entirely.
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

    // WMIC fallback for older Windows. Reports CreationDate as a local-time
    // `yyyymmddHHMMSS.ffffff±UUU` stamp, where UUU is MINUTES east of UTC.
    try {
      const out = execFileSync(
        "wmic",
        ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/value"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
      ).trim();
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
      // Subtract the offset to convert the local stamp to UTC.
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

/** A transfer whose process lives but whose bytes have stopped moving. */
export function isStalled(status: DownloadStatus, stallAfterMs: number, now = Date.now()): boolean {
  if (isTerminal(status.state)) return false;
  const last = status.lastByteAt ?? status.startedAt;
  return now - last > stallAfterMs;
}

export interface AcquireLeaseOptions {
  ownerId: string;
  leaseMs?: number;
  dir?: string;
  now?: number;
}

/**
 * Take ownership of a download, if it is free.
 *
 * Succeeds when unowned, already ours, or the previous lease expired. The
 * re-read after writing is the compare-and-swap: two instances racing both write,
 * but only the one whose value survives the final rename keeps the lease.
 */
export function acquireLease(id: string, options: AcquireLeaseOptions): DownloadStatus | null {
  const { ownerId, leaseMs = 30_000, dir, now = Date.now() } = options;

  // The read, the modify and the write all happen under one lock.
  //
  // Without it this function silently erased the runner's work: it read
  // `downloading`, the runner wrote `completed` a moment later, and then this
  // wrote its stale snapshot back — resurrecting a finished download as
  // in-flight, with a lease on it. The window is sub-millisecond and the two
  // writers are different processes, which is exactly the combination that
  // makes it look impossible right up until a user reports a download that
  // finished and then un-finished.
  return withFileLockSync(statusLockPath(id, dir), () => {
    const current = readStatus(id, dir);
    if (!current) return null;

    const heldByOther =
      current.ownerId !== undefined &&
      current.ownerId !== ownerId &&
      current.leaseUntil !== undefined &&
      current.leaseUntil > now;
    if (heldByOther) return null;

    writeStatus({ ...current, ownerId, leaseUntil: now + leaseMs }, dir);

    const confirmed = readStatus(id, dir);
    return confirmed?.ownerId === ownerId ? confirmed : null;
  });
}

export function releaseLease(id: string, ownerId: string, dir?: string): void {
  withFileLockSync(statusLockPath(id, dir), () => {
    const current = readStatus(id, dir);
    if (!current || current.ownerId !== ownerId) return;
    // `clearLease` is required: writeStatus otherwise preserves lease fields it
    // does not see, which is right for the runner heartbeat but would make
    // releasing a lease impossible.
    writeStatus({ ...current, ownerId: undefined, leaseUntil: undefined }, dir, { clearLease: true });
  });
}

export interface WatchOptions {
  intervalMs?: number;
  dir?: string;
  /**
   * Consecutive polls with no change before checking whether the runner is
   * still alive. A dead runner that never wrote a terminal state would
   * otherwise be watched forever, leaving the UI stuck on "Downloading".
   * Default 20 (≈8s at the default interval).
   */
  stalePollsBeforeLivenessCheck?: number;
}

export interface StatusWatcher {
  stop(): void;
}

/**
 * Poll a status file for changes.
 *
 * Polling rather than `fs.watch`: atomic writes replace the inode, so a watcher
 * bound to the original file silently stops firing after the first update.
 */
export function watchStatus(
  id: string,
  handlers: {
    onChange?: (status: DownloadStatus) => void;
    onSettled?: (status: DownloadStatus) => void;
    onMissing?: () => void;
    /** The runner died without recording an outcome. */
    onAbandoned?: (status: DownloadStatus) => void;
  },
  options: WatchOptions = {},
): StatusWatcher {
  const { intervalMs = 400, dir, stalePollsBeforeLivenessCheck = 20 } = options;
  let lastSerialized: string | undefined;
  let stopped = false;
  let unchangedPolls = 0;
  // Distinguishes "gone" from "not written yet" — see the missing-status branch.
  let everSeen = false;
  let missingPolls = 0;
  // Give a slow-starting runner a generous window before concluding the status
  // will never appear. At the default 400ms interval this is ~30s.
  const maxMissingPolls = Math.max(10, Math.ceil(30_000 / intervalMs));

  /** Deliver a terminal state exactly once, then stop polling. */
  const settle = (status: DownloadStatus, abandoned = false): void => {
    stopped = true;
    clearInterval(timer);
    // Handlers may be async; a rejection must not become an unhandled rejection
    // that takes down the command.
    try {
      const result = abandoned ? handlers.onAbandoned?.(status) : handlers.onSettled?.(status);
      void Promise.resolve(result).catch(() => undefined);
    } catch {
      // A throwing handler is the caller's problem, not a reason to crash here.
    }
  };

  const tick = () => {
    if (stopped) return;
    const status = readStatus(id, dir);
    if (!status) {
      // Two different situations wear the same face:
      //
      //   - We have seen this status before and it is now gone (cleared,
      //     pruned, or reconciled away). That is terminal — waiting cannot
      //     bring it back, and firing `onMissing` every tick forever would keep
      //     the watcher alive for the life of the command with nothing to say.
      //   - We have never seen it. The runner may simply not have written its
      //     first status yet. Giving up here would mean a watcher attached
      //     moments before the runner starts never reports any progress at all.
      //
      // So only a status that once existed is treated as terminal; otherwise
      // keep polling and let the caller's own timeout decide.
      missingPolls++;
      if (everSeen || missingPolls >= maxMissingPolls) {
        stopped = true;
        clearInterval(timer);
      }
      try {
        void Promise.resolve(handlers.onMissing?.()).catch(() => undefined);
      } catch {
        // A throwing handler is the caller's problem, not a crash here.
      }
      return;
    }
    everSeen = true;
    missingPolls = 0;

    const serialized = JSON.stringify(status);
    if (serialized !== lastSerialized) {
      lastSerialized = serialized;
      unchangedPolls = 0;
      try {
        handlers.onChange?.(status);
      } catch {
        // Keep polling even if a render callback throws.
      }
      if (isTerminal(status.state)) settle(status);
      return;
    }

    // Nothing changed. A runner that was SIGKILLed (or whose machine slept and
    // never resumed) leaves a non-terminal status that will never advance;
    // without this check the caller polls it forever and the UI stays stuck.
    unchangedPolls++;
    if (unchangedPolls >= stalePollsBeforeLivenessCheck && !isAlive(status)) {
      settle(status, true);
    }
  };

  const timer = setInterval(tick, intervalMs);
  // Don't hold a `no-view` command open purely because a watcher is ticking.
  timer.unref?.();
  tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export interface PruneOptions {
  olderThanMs?: number;
  dir?: string;
  now?: number;
}

/**
 * Remove finished/abandoned status files and their orphaned partial downloads.
 *
 * Without this, every crashed runner leaves a `.part` file that nothing will
 * ever finish and nothing will ever clean up.
 */
export function pruneStatuses(options: PruneOptions = {}): number {
  const { olderThanMs = 7 * 24 * 60 * 60 * 1000, dir, now = Date.now() } = options;
  const directory = dir ?? statusDir();
  let removed = 0;

  for (const listed of listStatuses(directory)) {
    withStatusLock(listed.id, directory, () => {
      // `listed` was necessarily read before this lock. A Retry may have
      // claimed its id in that window, so decide only from the locked reread.
      const status = readStatus(listed.id, directory);
      if (!status) return;

      const age = now - (status.finishedAt ?? status.heartbeatAt ?? status.startedAt);
      const alive = isAlive(status);
      const abandoned = !isTerminal(status.state) && !alive;

      // An empty `.part` is not a partial download — it is the touched-and-died
      // remains of a runner that crashed on startup. Nothing can resume from zero
      // bytes, so holding it for the retention window just leaves an inexplicable
      // file sitting in the user's Downloads folder. Reap it as soon as the
      // transfer is known dead. (Observed 2026-08-01: a 0-byte `.part` next to
      // every failed download, from a runner that could not load its own modules.)
      if (!alive && status.partPath) {
        try {
          if (existsSync(status.partPath) && statSync(status.partPath).size === 0) unlinkSync(status.partPath);
        } catch {
          // Best effort.
        }
      }

      if (age > olderThanMs || (abandoned && age > olderThanMs)) {
        // Only reap the partial once nothing can resume from it.
        try {
          if (status.partPath && existsSync(status.partPath)) unlinkSync(status.partPath);
        } catch {
          // Best effort.
        }
        clearStatus(status.id, directory);
        removed++;
      }
    });
  }

  return removed;
}
