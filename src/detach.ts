/**
 * Launching and cancelling detached downloads.
 *
 * `startDownload` spawns the runner so it outlives the calling command.
 * Verified: a parent that calls `process.exit(0)` immediately after spawning
 * still sees the child complete a multi-megabyte transfer.
 *
 * Cancellation has to reach the curl grandchild, not just the runner — killing
 * the runner alone orphans curl, which keeps writing to a file nobody tracks.
 * The two platforms need different mechanisms for that:
 *
 *   POSIX   `detached: true` makes the runner a process-group leader, so
 *           `process.kill(-pid)` signals the whole group. The runner catches
 *           SIGTERM and records `cancelled` itself.
 *   Windows There are no process groups and a negative pid is invalid; also
 *           `detached` there means "new console window", which would flash a
 *           black box at the user. So the child is merely `unref()`d and
 *           cancellation goes through `taskkill /T`, which walks the tree.
 *           Nothing catchable is delivered, so `killDownload` records the
 *           terminal status on the runner's behalf.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { hasCurl } from "./curl";
import { DownloadError } from "./errors";
import { writeSecretFile } from "./paths";
import {
  assertSafeId,
  isAlive,
  isTerminal,
  processStartTimeMs,
  readStatus,
  statusDir as defaultStatusDir,
  writeStatus,
  type DownloadStatus,
} from "./status";

export interface StartDownloadOptions {
  /** Stable identifier. Defaults to a random UUID. Reuse it to resume. */
  id?: string;
  url: string;
  /** Final destination. Bytes land in `<outputPath>.part` until verified. */
  outputPath: string;
  filename?: string;
  headers?: Record<string, string>;
  /** Known size, used for progress and to verify completeness. */
  expectedBytes?: number;
  /**
   * How to treat a size mismatch against `expectedBytes`.
   *
   * `"strict"` (default) fails the download. Correct when the size comes from
   * the same authority that minted the URL — an API response, say.
   *
   * `"advisory"` uses the size for progress but publishes the file anyway.
   * Correct when the size came from a separate `HEAD` request, which can
   * legitimately disagree with the `GET`: gzip transfer-encoding, a stale
   * `content-length`, or a server that serves different bodies to each verb.
   * Strict checking there would reject perfectly good downloads.
   */
  sizeCheck?: "strict" | "advisory";
  /** Continue from an existing partial file via HTTP Range. Default true. */
  resume?: boolean;
  speedLimitBytes?: number;
  stallSeconds?: number;
  /** Cap transfer rate in bytes/sec. Actually slows the download. */
  limitRateBytes?: number;
  /** Opaque payload echoed into the status file. NEVER put a signed URL here. */
  meta?: Record<string, unknown>;
  statusDir?: string;
  /** Override the runner path (tests). Defaults to the sibling `runner.js`. */
  runnerPath?: string;
  /**
   * Post a desktop notification when the download finishes or fails.
   *
   * This exists because of the gap detaching creates: once the window closes,
   * the toast is gone, and a completed transfer has nothing left to report to.
   * The runner outlives the command, so it is the only thing that can speak.
   *
   * See `RunnerPayload.notifyOnFinish` in `runner.ts` for the delivery routes
   * and why `raycastDeeplink` is opt-in.
   */
  notifyOnFinish?: { title: string; enabled: boolean; raycastDeeplink?: boolean };
}

export interface DownloadTicket {
  id: string;
  pid: number;
  statusPath: string;
}

/**
 * Every location the runner might live, cheapest first.
 *
 * This is harder than it looks because the runner is an executable ARTIFACT,
 * not an importable module: it has to exist as a real file that `node` can be
 * pointed at, and a bundler has no reason to preserve such a thing.
 *
 * Observed in Raycast (2026-08-01): esbuild inlines this package into a single
 * `search-meetings.js`, so `__dirname` is the extension bundle directory and
 * `runner.js` is nowhere near it. Every download failed before it started.
 *
 * Finding the file turned out to be only half the problem. Once the search
 * below located a copied `dist/runner.js` in `assets/`, it still died instantly
 * with `Cannot find module './curl'` — a `tsc` output carries its siblings by
 * reference, so copying one file out of `dist` copies a broken program. Hence
 * `runner.bundle.js` (see scripts/bundle-runner.mjs), which inlines the local
 * graph and is the ONLY form safe to copy. It is preferred everywhere below;
 * the unbundled paths remain as fallbacks for in-place `node_modules` use,
 * where the siblings really are present.
 */
function runnerCandidates(): string[] {
  // Raycast ships an extension's `assets/` directory alongside the bundle and
  // exposes its real location — the only dependable anchor inside a bundled
  // extension, since `__dirname` is the bundle and `cwd` is not ours to assume.
  let assetsPath: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { environment } = require("@raycast/api") as { environment?: { assetsPath?: string } };
    assetsPath = environment?.assetsPath;
  } catch {
    // Outside a Raycast host (tests, the runner itself).
  }

  return [
    // Explicit override, for layouts nothing here anticipates.
    process.env.RAYCAST_DOWNLOAD_RUNNER,
    // Bundled Raycast extension that copies the runner into assets/ at build
    // time (see the `copy-runner` script in the consumer's package.json).
    // This is the copied-artifact case, so it must be the self-contained
    // bundle — a copied `runner.js` cannot resolve its siblings.
    assetsPath ? join(assetsPath, "raycast-download-runner.js") : undefined,
    // Normal `node_modules` install, and the package's own tests. Both forms
    // work in place; prefer the bundle so what runs matches what ships.
    join(__dirname, "runner.bundle.js"),
    join(__dirname, "runner.js"),
    // Bundled consumer whose dependencies still exist on disk.
    join(process.cwd(), "node_modules", "@chrismessina", "raycast-download", "dist", "runner.bundle.js"),
    join(process.cwd(), "node_modules", "@chrismessina", "raycast-download", "dist", "runner.js"),
    join(process.cwd(), "assets", "raycast-download-runner.js"),
    join(process.cwd(), "runner.bundle.js"),
    join(process.cwd(), "runner.js"),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

/** Cached after first resolution — this runs on every download. */
let resolvedRunner: string | undefined;

/**
 * Absolute path to the runner, searching the locations above.
 *
 * Returns the conventional path when nothing is found, so the caller's error
 * names a concrete location rather than an empty string.
 */
export function runnerPath(): string {
  if (resolvedRunner && existsSync(resolvedRunner)) return resolvedRunner;

  for (const candidate of runnerCandidates()) {
    if (existsSync(candidate)) {
      resolvedRunner = candidate;
      return candidate;
    }
  }

  return join(__dirname, "runner.js");
}

/** The locations `runnerPath()` searched — for a diagnosable error message. */
export function runnerSearchPaths(): string[] {
  return runnerCandidates();
}

/**
 * Spawn a detached download. Resolves once the runner has written its first
 * status, so the caller can immediately watch a file that exists.
 */
export async function startDownload(options: StartDownloadOptions): Promise<DownloadTicket> {
  const {
    id = randomUUID(),
    url,
    outputPath,
    headers,
    expectedBytes,
    resume = true,
    speedLimitBytes,
    stallSeconds,
    limitRateBytes,
    sizeCheck = "strict",
    meta,
    statusDir = defaultStatusDir(),
    runnerPath: runnerOverride,
    notifyOnFinish,
  } = options;

  // Rejects an id that could escape statusDir via `join()`. Done before any
  // path is built from it.
  assertSafeId(id);

  const filename = options.filename ?? outputPath.split("/").pop() ?? "download";
  const partPath = `${outputPath}.part`;
  const runner = runnerOverride ?? runnerPath();

  if (!existsSync(runner)) {
    // Name every location searched. The previous message gave only one path,
    // which made a bundling problem look like a missing file.
    throw new DownloadError(
      "validation",
      `Download runner not found. Looked in:\n${runnerSearchPaths()
        .map((p) => `  - ${p}`)
        .join("\n")}\n` +
        `If this extension is bundled, copy the package's dist/runner.js next to the bundle, ` +
        `or set RAYCAST_DOWNLOAD_RUNNER to its path.`,
    );
  }

  // Fail here rather than minutes later inside the runner: a missing binary is a
  // prerequisite the user can fix, not a transport error.
  if (!hasCurl()) {
    throw new DownloadError(
      "validation",
      "curl is required to download files but was not found on this system.",
    );
  }

  // The payload carries the URL, so it goes in a 0600 file rather than argv,
  // which `ps` exposes to every process on the machine. The runner unlinks it.
  const payloadPath = join(statusDir, `${id}.payload.json`);
  writeSecretFile(
    payloadPath,
    JSON.stringify({
      id,
      url,
      outputPath,
      partPath,
      filename,
      statusDir,
      headers,
      expectedBytes,
      resume,
      speedLimitBytes,
      stallSeconds,
      limitRateBytes,
      sizeCheck,
      meta,
      notifyOnFinish,
    }),
  );

  const child = spawn(process.execPath, [runner, payloadPath], {
    // POSIX: makes the child a process-group leader so `kill(-pid)` reaches
    // curl too, and detaches it from the parent's session so it survives the
    // command being unloaded.
    //
    // Windows: `detached` instead means "open a new console window", which
    // would flash a black box at the user. `unref()` alone is what lets the
    // child outlive the parent there, and `taskkill /T` handles the tree.
    detached: process.platform !== "win32",
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  const pid = child.pid;
  if (pid === undefined) {
    try {
      unlinkSync(payloadPath);
    } catch {
      // Best effort.
    }
    throw new DownloadError("unknown", "Could not start the download process.");
  }

  // Wait briefly for the runner's first status write, so callers can watch a
  // file that already exists rather than racing it.
  const seeded = await waitForStatus(id, statusDir, 3000);
  if (!seeded) {
    // The runner may still be starting; seed a status so the download is
    // visible and cancellable rather than invisible until its first write.
    const now = Date.now();
    writeStatus(
      {
        schema: 1,
        id,
        pid,
        startedAtMs: processStartTimeMs(pid) ?? now,
        state: "starting",
        filename,
        outputPath,
        partPath,
        bytesDownloaded: 0,
        totalBytes: expectedBytes,
        startedAt: now,
        heartbeatAt: now,
        meta,
      },
      statusDir,
    );
  }

  return { id, pid, statusPath: join(statusDir, `${id}.json`) };
}

async function waitForStatus(id: string, dir: string, timeoutMs: number): Promise<DownloadStatus | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readStatus(id, dir);
    if (status) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

export interface KillOptions {
  statusDir?: string;
  /** Escalate to SIGKILL if the group is still alive after this long. */
  graceMs?: number;
}

/**
 * Cancel a download by signalling its process group.
 *
 * Refuses to signal when the recorded `(pid, startTime)` no longer matches a
 * live process: macOS `kern.maxproc` is 16000, so a stale pid can belong to an
 * unrelated process, and killing its whole group would be a serious bug.
 *
 * Returns true when a signal was delivered.
 */
export async function killDownload(
  ticket: { id: string; pid?: number },
  options: KillOptions = {},
): Promise<boolean> {
  const { statusDir = defaultStatusDir(), graceMs = 2000 } = options;

  const status = readStatus(ticket.id, statusDir);
  if (!status) return false;

  // Identity check, not merely liveness.
  if (!isAlive(status)) {
    // Already gone: record the outcome so the UI stops showing it as running.
    if (status.state !== "completed") {
      writeStatus({ ...status, state: "cancelled", finishedAt: Date.now() }, statusDir);
    }
    return false;
  }

  // `isAlive` deliberately assumes ALIVE when identity cannot be proven —
  // reporting a running download as dead is the more damaging error there.
  //
  // Signalling inverts that trade: acting on an unproven identity could take an
  // unrelated process tree down with it if the pid was recycled. So killing
  // requires the STRONG check. Without it, stop tracking and say so rather than
  // guessing.
  if (processStartTimeMs(status.pid) === undefined) {
    writeStatus(
      {
        ...status,
        state: "cancelled",
        finishedAt: Date.now(),
        error: {
          code: "cancelled",
          message:
            "Stopped tracking this download — this system could not confirm which process owns it, so it was not force-stopped. It may still be running.",
        },
      },
      statusDir,
    );
    return false;
  }

  if (!terminateTree(status.pid, "SIGTERM")) return false;

  // Escalate only if it ignored the polite signal.
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  const after = readStatus(ticket.id, statusDir);
  if (after && isAlive(after)) {
    terminateTree(after.pid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // Make sure a terminal state actually got recorded.
  //
  // On POSIX the runner's SIGTERM handler writes `cancelled` itself. On Windows
  // `taskkill` terminates the tree without delivering a catchable signal, so
  // nothing in the runner ever runs — the status would sit at `downloading`
  // forever and a watcher would keep polling a download that no longer exists.
  const settled = readStatus(ticket.id, statusDir);
  if (settled && !isTerminal(settled.state) && !isAlive(settled)) {
    writeStatus({ ...settled, state: "cancelled", finishedAt: Date.now() }, statusDir);
  }

  return true;
}

/**
 * Kill a runner and the curl child it spawned.
 *
 * POSIX: signal the process GROUP via a negative pid. `detached: true` made the
 * runner a group leader, so this reaches curl too — killing the bare pid would
 * orphan curl, which keeps writing to a file nobody is tracking.
 *
 * Windows: there are no process groups and negative pids are invalid, so this
 * delegates to `taskkill /T`, which walks the process tree instead.
 */
function terminateTree(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
  if (process.platform === "win32") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
      const args = ["/PID", String(pid), "/T"];
      // /F is a forced kill; only escalate to it when SIGTERM's equivalent has
      // already been tried.
      if (signal === "SIGKILL") args.push("/F");
      execFileSync("taskkill", args, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile a status whose runner is no longer alive.
 *
 * The important case is `finalizing`: the runner renamed the file into place and
 * died before recording completion. The bytes are on disk and correct, so
 * reporting a failure — and offering to re-download hundreds of megabytes —
 * would be wrong.
 */
export function reconcile(status: DownloadStatus, statusDir?: string): DownloadStatus {
  if (status.state === "completed" || status.state === "failed" || status.state === "cancelled") return status;
  if (isAlive(status)) return status;

  const finalExists = existsSync(status.outputPath);
  const sizeMatches =
    finalExists &&
    (status.totalBytes === undefined || safeSize(status.outputPath) === status.totalBytes);

  const reconciled: DownloadStatus =
    status.state === "finalizing" && sizeMatches
      ? {
          ...status,
          state: "completed",
          finishedAt: status.finishedAt ?? Date.now(),
          bytesDownloaded: safeSize(status.outputPath),
        }
      : {
          ...status,
          state: "failed",
          finishedAt: status.finishedAt ?? Date.now(),
          error: status.error ?? describeAbandonment(status),
        };

  try {
    writeStatus(reconciled, statusDir);
  } catch {
    // Reporting the reconciled state matters more than persisting it.
  }
  return reconciled;
}

/**
 * Describe HOW an abandoned download died, using what is actually on disk.
 *
 * The previous single message claimed "The partial file was kept, so it can
 * resume" unconditionally. When the runner died before writing a byte — which
 * is exactly what a crash-on-startup looks like — that sentence was false in
 * both halves: nothing was kept and nothing can resume. It also read as a
 * transient network hiccup, so the natural response was to retry, which
 * reproduced the crash forever. A misleading error is worse than a vague one;
 * it aims the user away from the cause.
 *
 * The distinguishing signal is bytes-on-disk. A runner that never moved a byte
 * did not fail mid-transfer; it failed to start.
 */
function describeAbandonment(status: DownloadStatus): NonNullable<DownloadStatus["error"]> {
  const partialBytes = existsSync(status.partPath) ? safeSize(status.partPath) : 0;

  if (partialBytes > 0) {
    return {
      code: "interrupted",
      message: "The download stopped unexpectedly. The partial file was kept, so it can resume.",
    };
  }

  // No bytes and no partial: the transfer never got underway. Naming the phase
  // is what makes this diagnosable — the runner is a separate process, so its
  // startup failures (a missing module, an unusable output directory, no `node`)
  // leave no trace in the parent beyond this status.
  return {
    code: "runner_failed",
    message:
      "The download stopped before any data transferred, so the helper process most likely failed to start. " +
      "Nothing was written to disk.",
  };
}

function safeSize(path: string): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { statSync } = require("node:fs") as typeof import("node:fs");
    return statSync(path).size;
  } catch {
    return 0;
  }
}
