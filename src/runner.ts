/**
 * The detached download runner.
 *
 * Runs as its own process, outliving the Raycast command that spawned it.
 * Reports exclusively through the status file — nothing here can talk to a UI.
 *
 * MUST NOT import `@raycast/api`: this executes outside Raycast's host, where
 * that module does not resolve.
 *
 * Invoked as:  node runner.js <payloadJsonPath>
 *
 * The payload arrives via a 0600 FILE rather than argv because it carries the
 * download URL, which for signed-URL APIs is a bearer credential and argv is
 * world-readable through `ps`. The runner unlinks the payload immediately.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { buildCurlConfig, classifyCurlFailure, parseCurlMeter, parseWriteOut } from "./curl";
import { writeSecretFile } from "./paths";
import { isTerminal, writeStatus, type DownloadStatus } from "./status";

interface RunnerPayload {
  id: string;
  url: string;
  outputPath: string;
  partPath: string;
  filename: string;
  statusDir: string;
  headers?: Record<string, string>;
  expectedBytes?: number;
  resume?: boolean;
  speedLimitBytes?: number;
  stallSeconds?: number;
  limitRateBytes?: number;
  sizeCheck?: "strict" | "advisory";
  meta?: Record<string, unknown>;
  /**
   * Post a desktop notification on completion or failure.
   *
   * Off unless the caller asks. The point is the case a detached download
   * creates and nothing else can cover: the user dismisses the window, the
   * transfer keeps running, and the toast that would have reported the outcome
   * died with the command. The file then lands silently and the user has no way
   * to know it finished — which reads as the download having failed.
   *
   * Delivery route, and why the default is what it is:
   *
   *   `osascript` (default) — always available, needs nothing installed, but is
   *     attributed to Script Editor, icon included. There is no way to change
   *     that from a detached process without shipping a signed helper.
   *
   *   `raycastDeeplink` — `open -g "raycast://…"` against maxnyby's
   *     `raycast-notification` extension. Renders as Raycast, so it looks right.
   *     Raycast prompts for approval the first time, but the prompt offers
   *     "always allow", so it is a one-time cost rather than a dialog on every
   *     completed download.
   *
   *     Opt-in rather than default because it depends on a SEPARATE extension
   *     the user may not have: when it is absent the notification is dropped on
   *     the floor, and `open` exits 0 regardless — so the runner can neither
   *     detect the failure nor fall back to osascript. Defaulting to it would
   *     trade a wrong icon for no notification at all.
   */
  notifyOnFinish?: { title: string; enabled: boolean; raycastDeeplink?: boolean };
}

const HEARTBEAT_MS = 500;

function main(): void {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    process.exit(2);
  }

  const payload = JSON.parse(readFileSync(payloadPath, "utf8")) as RunnerPayload;
  // The payload holds the signed URL; remove it from disk before transferring.
  try {
    unlinkSync(payloadPath);
  } catch {
    // Nothing to do — proceed rather than abandoning the download.
  }

  const startedAt = Date.now();
  let status: DownloadStatus = {
    schema: 1,
    id: payload.id,
    pid: process.pid,
    startedAtMs: startedAt,
    state: "starting",
    filename: payload.filename,
    outputPath: payload.outputPath,
    partPath: payload.partPath,
    bytesDownloaded: 0,
    totalBytes: payload.expectedBytes,
    startedAt,
    heartbeatAt: startedAt,
    meta: payload.meta,
  };

  const persist = (next: Partial<DownloadStatus>): void => {
    status = { ...status, ...next, heartbeatAt: Date.now() };
    try {
      writeStatus(status, payload.statusDir);
    } catch {
      // A failed status write must not kill an otherwise healthy transfer.
    }
  };

  persist({});

  mkdirSync(dirname(payload.partPath), { recursive: true });

  // Resume only when there is something to resume from; `-C -` against a
  // zero-byte or absent file makes curl error rather than start cleanly.
  const existingBytes = existsSync(payload.partPath) ? safeSize(payload.partPath) : 0;
  const resume = Boolean(payload.resume) && existingBytes > 0;

  let configPath: string;
  try {
    const config = buildCurlConfig({
      url: payload.url,
      outputPath: payload.partPath,
      headers: payload.headers,
      resume,
      speedLimitBytes: payload.speedLimitBytes,
      stallSeconds: payload.stallSeconds,
      limitRateBytes: payload.limitRateBytes,
    });
    configPath = `${payload.partPath}.curlrc`;
    writeSecretFile(configPath, config);
  } catch (error) {
    // buildCurlConfig rejects control characters in the URL or headers.
    persist({
      state: "failed",
      finishedAt: Date.now(),
      error: { code: "validation", message: error instanceof Error ? error.message : String(error) },
    });
    process.exit(1);
    return;
  }

  const child = spawn("curl", ["-K", configPath], { stdio: ["ignore", "pipe", "pipe"] });

  // The config holds the download URL, which for signed-URL APIs is a bearer
  // credential — so it comes off disk as soon as curl has read it.
  //
  // curl parses its config at startup (measured: unlinking 50ms after spawn
  // still completes a full transfer), so the first byte of output is proof it
  // no longer needs the file. The timer is only a fallback for a transfer that
  // produces no output at all.
  let configRemoved = false;
  const removeConfig = (): void => {
    if (configRemoved) return;
    configRemoved = true;
    try {
      unlinkSync(configPath);
    } catch {
      // Already gone.
    }
  };
  child.stderr?.once("data", removeConfig);
  child.stdout?.once("data", removeConfig);
  const configTimer = setTimeout(removeConfig, 2000);
  configTimer.unref?.();

  persist({ state: "downloading", bytesDownloaded: existingBytes });

  let stdout = "";
  let stderr = "";
  let lastBytes = existingBytes;
  let lastByteAt = Date.now();

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    // Keep only the tail: the meter rewrites itself thousands of times and an
    // unbounded buffer makes the regex scan quadratic over a long transfer.
    if (stderr.length > 8192) stderr = stderr.slice(-4096);

    const progress = parseCurlMeter(stderr);
    if (!progress) return;

    // curl reports bytes for THIS invocation; a resumed transfer starts at 0.
    const absolute = resume ? existingBytes + progress.bytesDownloaded : progress.bytesDownloaded;
    if (absolute > lastBytes) {
      lastBytes = absolute;
      lastByteAt = Date.now();
    }

    persist({
      bytesDownloaded: absolute,
      totalBytes: progress.totalBytes ? (resume ? existingBytes + progress.totalBytes : progress.totalBytes) : status.totalBytes,
      speedBytesPerSec: progress.speedBytesPerSec,
      etaSeconds: progress.etaSeconds,
      lastByteAt,
    });
  });

  // Independent heartbeat: proves the process is alive even when the meter is
  // silent, so a reader can distinguish "hung" from "dead".
  const heartbeat = setInterval(() => {
    if (!isTerminal(status.state)) persist({});
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const finishCancelled = (): void => {
    clearInterval(heartbeat);
    removeConfig();
    // Keep the .part file: cancellation should still allow a later resume.
    persist({ state: "cancelled", finishedAt: Date.now() });
    process.exit(0);
  };

  // A group-kill (`process.kill(-pid)`) lands here first.
  //
  // On Windows `taskkill /T` terminates the tree without delivering a catchable
  // signal, so this handler never runs there and no `cancelled` status is
  // written. That is why `killDownload` records the outcome itself when the
  // process is already gone — the reader must not be left watching a status
  // that will never advance.
  process.on("SIGTERM", finishCancelled);
  process.on("SIGINT", finishCancelled);

  child.on("error", (error) => {
    clearInterval(heartbeat);
    removeConfig();
    persist({
      state: "failed",
      finishedAt: Date.now(),
      error: { code: "unknown", message: error.message },
    });
    process.exit(1);
  });

  child.on("close", (exitCode, signal) => {
    clearInterval(heartbeat);
    // Belt and braces: the listeners above normally win, but a transfer that
    // produced no output at all must not leave the credential on disk.
    removeConfig();

    const writeOut = parseWriteOut(stdout);
    const httpCode = writeOut.httpCode;
    const succeeded = exitCode === 0 && (httpCode === undefined || (httpCode >= 200 && httpCode < 400));

    if (!succeeded) {
      const error = classifyCurlFailure({ exitCode, signal, httpCode, stderrTail: stderr });
      // The .part file is retained so a retry can resume — but only when it
      // holds something to resume FROM. curl creates the file on open, so a
      // request that failed before its first byte (404, DNS, TLS) leaves a
      // 0-byte file that can never be resumed and that the user has no way to
      // account for sitting in their Downloads folder.
      discardEmptyPart(payload.partPath);
      const cancelled = error.code === "cancelled";
      persist({
        state: cancelled ? "cancelled" : "failed",
        finishedAt: Date.now(),
        error: { code: error.code, message: error.message, httpStatus: error.httpStatus },
      });
      // Cancellation is deliberately silent: the user performed it, so telling
      // them it happened is noise. A genuine failure is the opposite — with the
      // window closed, this notification is the only way they learn about it.
      if (!cancelled) notify(payload, "Download Failed", `${payload.filename} — ${error.message}`);
      process.exit(1);
      return;
    }

    // Verify before publishing. A truncated file that merely exists is worse
    // than a visible failure, because it looks like a successful download.
    const finalBytes = safeSize(payload.partPath);

    // Only a caller-supplied total is a trustworthy expectation of the WHOLE
    // file. curl's `size_download` counts bytes transferred in THIS invocation,
    // so on a resumed transfer it is the remainder, not the total — comparing
    // it against the full `.part` size would fail every correct resume.
    //
    // With no caller-supplied size there is nothing to verify against, so a
    // clean curl exit is the only available signal. Better to publish on that
    // than to invent an expectation and reject good downloads.
    const expected = payload.expectedBytes;

    const strict = (payload.sizeCheck ?? "strict") === "strict";
    if (strict && expected !== undefined && expected > 0 && finalBytes !== expected) {
      persist({
        state: "failed",
        finishedAt: Date.now(),
        bytesDownloaded: finalBytes,
        error: {
          code: "integrity",
          message: `Incomplete download: expected ${expected} bytes, got ${finalBytes}.`,
        },
      });
      process.exit(1);
      return;
    }

    // Sanity check for the no-expected-size case: curl exited 0 but produced an
    // empty file. Publishing a zero-byte "recording" would look like success.
    if (expected === undefined && finalBytes === 0) {
      persist({
        state: "failed",
        finishedAt: Date.now(),
        bytesDownloaded: 0,
        error: { code: "integrity", message: "The server returned an empty file." },
      });
      process.exit(1);
      return;
    }

    // Publish atomically. `finalizing` is written FIRST so that a crash between
    // the rename and the completion write is recoverable: a reader seeing a dead
    // runner in `finalizing` with a correctly-sized final file reconciles it to
    // completed rather than reporting a spurious failure.
    persist({ state: "finalizing", bytesDownloaded: finalBytes, totalBytes: expected ?? finalBytes });

    try {
      renameSync(payload.partPath, payload.outputPath);
    } catch (error) {
      persist({
        state: "failed",
        finishedAt: Date.now(),
        error: { code: "permission", message: error instanceof Error ? error.message : String(error) },
      });
      process.exit(1);
      return;
    }

    persist({ state: "completed", finishedAt: Date.now(), bytesDownloaded: finalBytes, speedBytesPerSec: undefined, etaSeconds: undefined });
    // After the status write: a watching window should update immediately, and
    // a notification that hangs must not delay it.
    notify(payload, "Download Complete", payload.filename);
    process.exit(0);
  });
}

function safeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Post a desktop notification, if the caller asked for one.
 *
 * Entirely best-effort and deliberately fire-and-forget: this runs at the very
 * end of a download, and a notification that fails must never turn a completed
 * transfer into a reported failure. Every error path here is swallowed.
 *
 * Values are passed as ARGUMENTS to osascript rather than interpolated into the
 * script text. Meeting titles are user data and routinely contain quotes and
 * backslashes; splicing them into AppleScript source would mean a title like
 * `Q3 "review"` either breaks the script or executes as code.
 */
function notify(payload: RunnerPayload, subtitle: string, message: string): void {
  const notifyOption = payload.notifyOnFinish;
  if (!notifyOption?.enabled) return;

  try {
    if (process.platform === "darwin") {
      if (notifyOption.raycastDeeplink) {
        // Opt-in only — see the option's docs for why this cannot be the
        // default or a fallback target.
        const args = encodeURIComponent(JSON.stringify({ title: `${subtitle}: ${message}` }));
        execFileSync(
          "open",
          ["-g", `raycast://extensions/maxnyby/raycast-notification/index?launchType=background&arguments=${args}`],
          { stdio: "ignore", timeout: 5000 },
        );
        return;
      }

      execFileSync(
        "osascript",
        [
          "-e",
          "on run {t, s, m}\ndisplay notification m with title t subtitle s\nend run",
          notifyOption.title,
          subtitle,
          message,
        ],
        { stdio: "ignore", timeout: 5000 },
      );
      return;
    }

    if (process.platform === "win32") {
      // PowerShell's balloon API needs no extra install, unlike toast modules.
      const script =
        "[reflection.assembly]::LoadWithPartialName('System.Windows.Forms')>$null;" +
        "$n=New-Object System.Windows.Forms.NotifyIcon;" +
        "$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;" +
        "$n.ShowBalloonTip(5000,$env:NOTIFY_TITLE,$env:NOTIFY_TEXT,'Info');Start-Sleep -Seconds 5";
      execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: "ignore",
        timeout: 10000,
        // Via env, for the same injection reason as the AppleScript arguments.
        env: { ...process.env, NOTIFY_TITLE: `${notifyOption.title} — ${subtitle}`, NOTIFY_TEXT: message },
      });
    }
  } catch {
    // A missing osascript, a suppressed notification, a timeout — none of it
    // says anything about whether the download succeeded.
  }
}

/**
 * Remove a `.part` file that holds no bytes.
 *
 * Deliberately size-guarded rather than unconditional: a partial with real
 * bytes in it is the entire basis for resuming, including after a cancellation,
 * and deleting one would turn a resumable interruption into a full re-download.
 * Only the empty case — where there is provably nothing to resume from — is
 * safe to discard.
 */
function discardEmptyPart(partPath: string): void {
  try {
    if (existsSync(partPath) && statSync(partPath).size === 0) unlinkSync(partPath);
  } catch {
    // Best effort: failing to tidy up must never fail the download's outcome.
  }
}

main();
