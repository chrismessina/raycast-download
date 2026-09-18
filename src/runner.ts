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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { buildCurlConfig, classifyCurlFailure, parseCurlMeter, parseWriteOut } from "./curl";
import { rollbackPartial, writeSecretFile } from "./paths";
import {
  clearPartialState,
  headerPath,
  markPartialUnsafe,
  mayResume,
  parseValidators,
  readPartialState,
  releasePartialClaim,
  resetPartial,
  resourceFingerprint,
  urlFingerprint,
  writePartialState,
} from "./partial";
import { isTerminal, processStartTimeMs, writeStatus, type DownloadStatus } from "./status";

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
  /** Follow HTTP redirects. Default true. */
  followRedirects?: boolean;
  speedLimitBytes?: number;
  stallSeconds?: number;
  limitRateBytes?: number;
  sizeCheck?: "strict" | "advisory";
  /**
   * Proof that this runner owns the claim on `partPath`.
   *
   * Inherited from the command that spawned it. Releasing by pathname alone
   * would let a late cleanup here delete a claim a LATER attempt has since
   * taken, so the token travels with the work it authorises.
   */
  claimToken?: string;
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
  // The OS process creation time, NOT the time JavaScript got here.
  //
  // `(pid, startedAtMs)` is the identity every liveness and kill check compares
  // against, with a 2s tolerance for `ps` reporting whole seconds. A cold Node
  // start under load takes longer than that, so recording the JS-init timestamp
  // made a perfectly healthy runner fail its own identity check: `isAlive`
  // returned false while bytes were still arriving, and the download was
  // reconciled as abandoned mid-transfer. Read the value the checkers read.
  const startedAtMs = processStartTimeMs(process.pid) ?? startedAt;
  let status: DownloadStatus = {
    schema: 1,
    id: payload.id,
    pid: process.pid,
    startedAtMs,
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

  /**
   * Record what the bytes currently in the `.part` file are, so the NEXT
   * attempt can decide whether it may append to them.
   *
   * Called on every path that leaves a partial behind — failure and
   * cancellation alike — because a cancelled transfer is the one users resume
   * most. Without this the next attempt sees only a byte count, which is not
   * evidence of anything.
   */
  const recordPartialForResume = (): void => {
    const validators = readValidators(payload.partPath);
    const existing = readPartialState(payload.partPath);

    // Whether THIS attempt got a response at all decides whose validators apply.
    //
    // A header dump exists only once curl has read response headers, and from
    // that moment the bytes this attempt is writing belong to that response —
    // so its validators are the whole answer, including when it supplied none.
    // Falling back to an older validator there is the same defect this release
    // fixes in `parseValidators`, one level up: a validator recorded against
    // bytes it never described. It is reachable through a weak `ETag`, which
    // `parseValidators` drops by design, and the fallback would then resurrect
    // a strong one from an unrelated earlier response and send it as
    // `If-Range` — precisely what the server just told us not to do.
    //
    // NOT keyed on the file's size: curl buffers, so a transfer can be minutes
    // into a response with a `.part` file still reporting zero bytes. Measured,
    // and it is why the first version of this check kept the stale validator.
    const etag = validators ? validators.etag : existing?.etag;
    const lastModified = validators ? validators.lastModified : existing?.lastModified;

    writePartialState(payload.partPath, {
      v: 1,
      ...(existing?.unsafe ? { unsafe: true as const } : {}),
      urlHash,
      resourceHash: resourceFingerprint(payload.url),
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
    });
  };

  /** Every transient file this attempt owns, gone. The claim goes with them. */
  const releasePath = (): void => {
    discardHeaderDump(payload.partPath);
    releasePartialClaim(payload.partPath, payload.claimToken);
  };

  /**
   * The partial holds bytes that must never be appended to, and this runner
   * could not remove them. The durable marker is what stops the next attempt;
   * the status field is how a consumer finds out.
   */
  const failUnsafePartial = (message: string): void => {
    markPartialUnsafe(payload.partPath);
    releasePath();
    persist({
      state: "failed",
      finishedAt: Date.now(),
      partialUnsafe: true,
      error: { code: "integrity", message },
    });
  };

  const failSetup = (code: "validation" | "permission", error: unknown): void => {
    // `uniquePath(..., { reserve: true })` creates this empty `.part` before
    // launching us. No transfer has begun on setup failure, so retaining it
    // cannot help resume and instead burns the original filename forever.
    discardEmptyPart(payload.partPath);
    releasePath();
    persist({
      state: "failed",
      finishedAt: Date.now(),
      error: { code, message: error instanceof Error ? error.message : String(error) },
    });
  };

  try {
    mkdirSync(dirname(payload.partPath), { recursive: true });
  } catch (error) {
    failSetup("permission", error);
    process.exit(1);
    return;
  }

  // What is already on disk, and what is KNOWN about it.
  //
  // A byte offset is not a licence to append. curl cannot check the prefix — a
  // range request asserts it is already correct — so a partial whose provenance
  // we cannot establish is reset rather than resumed. Measured against a
  // Range-capable server: an 8-byte garbage prefix resumes to exit 0, HTTP 206,
  // and a published file reading `XXXXXXXX89ABCDEFGHIJ`.
  let existingBytes = existsSync(payload.partPath) ? safeSize(payload.partPath) : 0;
  const partialState = readPartialState(payload.partPath);
  const urlHash = urlFingerprint(payload.url);

  if (existingBytes > 0 && partialState?.unsafe) {
    // A previous attempt spoiled these bytes and said so. Start over — but only
    // once the spoiled bytes are provably gone, because failing to remove them
    // and downloading anyway is the corruption this marker exists to prevent.
    if (!resetPartial(payload.partPath)) {
      failUnsafePartial(
        `The partial file for ${payload.filename} holds data from a failed attempt and could not be cleared. Delete ${payload.partPath} and try again.`,
      );
      process.exit(1);
      return;
    }
    existingBytes = 0;
  } else if (existingBytes > 0 && !mayResume(partialState, payload.url)) {
    // These bytes were not put here by this download.
    //
    // Either they carry another URL's fingerprint, or they carry none at all —
    // a partial from before this package recorded provenance, or a file that
    // simply happens to sit at this path. Both are the same question, and the
    // honest answer to "is this a correct prefix of what I am about to fetch?"
    // is "unknown". A range request asserts that it IS correct, so an unknown
    // prefix may not be resumed onto: the splice is invisible to curl, to the
    // server, and to every size check downstream.
    //
    // The cost is one re-download, once, for a partial this version did not
    // write. Provenance is recorded as soon as the response headers land, so a
    // runner that is SIGKILLed mid-transfer still leaves a resumable partial —
    // the sleep-and-resume case the package exists for is unaffected.
    if (!resetPartial(payload.partPath)) {
      failUnsafePartial(
        `The partial file for ${payload.filename} cannot be identified as part of this download, and could not be cleared. Delete ${payload.partPath} and try again.`,
      );
      process.exit(1);
      return;
    }
    existingBytes = 0;
  }

  const resume = Boolean(payload.resume) && existingBytes > 0;

  // `If-Range` only where the validator describes the bytes we are appending
  // to. With a strong ETag, a changed resource comes back 200 and curl refuses
  // (exit 33) instead of splicing; `Last-Modified` is the documented fallback.
  const ifRange = resume ? (partialState?.etag ?? partialState?.lastModified) : undefined;

  const followRedirects = payload.followRedirects ?? true;

  let configPath: string;
  try {
    const config = buildCurlConfig({
      url: payload.url,
      outputPath: payload.partPath,
      headers: payload.headers,
      followRedirects,
      resume,
      speedLimitBytes: payload.speedLimitBytes,
      stallSeconds: payload.stallSeconds,
      limitRateBytes: payload.limitRateBytes,
      dumpHeaderPath: headerPath(payload.partPath),
      ifRange,
    });
    configPath = `${payload.partPath}.curlrc`;
    writeSecretFile(configPath, config);
  } catch (error) {
    // buildCurlConfig rejects control characters in the URL or headers.
    failSetup("validation", error);
    process.exit(1);
    return;
  }

  // A runner killed mid-transfer leaves its header dump behind, and reading it
  // as THIS attempt's response is exactly the stale-validator bug one release
  // over. Cleared before curl can write a new one.
  discardHeaderDump(payload.partPath);

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
  let provenanceRecorded = false;
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

    // A meter line means the response arrived, so curl has dumped its headers.
    // Recorded HERE rather than at exit because the transfers that most need a
    // resumable partial are the ones with no exit at all: a SIGKILLed runner, a
    // machine that slept and never woke the process. Written once.
    if (!provenanceRecorded) {
      provenanceRecorded = true;
      recordPartialForResume();
    }

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
    // Keep the .part file: cancellation should still allow a later resume — and
    // record what those bytes are, which is what MAKES the later resume safe.
    recordPartialForResume();
    releasePath();
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
    discardEmptyPart(payload.partPath);
    releasePath();
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
    // Success is strictly 2xx. A 3xx is NEVER a downloaded file:
    //
    //  - redirects off: curl writes the redirect BODY to the `.part` file and
    //    exits 0, so accepting it renames a stub to the user's expected
    //    filename and publishes it as a completed download;
    //  - redirects ON: `location` only follows a response carrying a usable
    //    `Location`, so a 304 (caller sent a conditional header) or a 300 is
    //    still the final status. A 304 writes NO body, which on a resumed
    //    transfer would publish the existing partial as if it were whole.
    //
    // When redirects were followed and the transfer really succeeded, curl
    // reports the 2xx of the final hop, so nothing legitimate is lost here.
    const httpOk = httpCode === undefined || (httpCode >= 200 && httpCode < 300);
    const succeeded = exitCode === 0 && httpOk;

    if (!succeeded) {
      const error = classifyCurlFailure({ exitCode, signal, httpCode, stderrTail: stderr, followRedirects });
      // The .part file is retained so a retry can resume — but only when it
      // holds something to resume FROM. curl creates the file on open, so a
      // request that failed before its first byte (404, DNS, TLS) leaves a
      // 0-byte file that can never be resumed and that the user has no way to
      // account for sitting in their Downloads folder.
      // …except whatever a 3xx wrote, which is never resumable content. curl
      // writes the redirect BODY to the `.part` file, so a later retry would
      // `continue-at` past that HTML and splice the real file onto it — the
      // exact silent corruption `fail` exists to prevent.
      //
      // Rolled back to `existingBytes` rather than deleted outright: on a
      // resumed transfer those bytes are the user's real progress and a 304
      // response in particular means the partial is still valid. Only the bytes
      // THIS attempt appended are garbage.
      const redirectStub = error.httpStatus !== undefined && error.httpStatus >= 300 && error.httpStatus < 400;

      // curl REFUSING to resume: it asked for a range and got a whole body.
      // Measured — that happens both when the server has no Range support and
      // when `If-Range` says the resource changed underneath us, and curl
      // leaves the partial untouched either way. Those bytes can never complete
      // this download, and every retry resumes onto them again, so the file is
      // reset here instead of being retained as if it were progress.
      // Scoped to a 2xx answer, NOT every exit 33. curl reports 33 for any
      // non-206 response to a ranged request, including a 304 — and a 304 says
      // the partial is STILL VALID, so resetting there would destroy real
      // progress to fix a conditional header the caller chose to send.
      const rangeRefused = exitCode === 33 && httpCode !== undefined && httpCode >= 200 && httpCode < 300;
      if (rangeRefused) {
        if (!resetPartial(payload.partPath)) {
          failUnsafePartial(
            `The partial file for ${payload.filename} cannot be resumed and could not be cleared. Delete ${payload.partPath} and try again.`,
          );
          process.exit(1);
          return;
        }
      }

      // `rolledBack` is READ, not discarded. When the partial could not be made
      // safe — deletion denied AND emptying denied — the redirect body is still
      // on disk, and the next attempt would compute `existingBytes` from that
      // longer file and `curl -C -` the real recording onto the end of it. That
      // is precisely the corruption this branch exists to prevent, so it has to
      // reach the status as `partialUnsafe`: a consumer cannot see a cleanup
      // failure any other way, and `bytesDownloaded: 0` cannot carry it (an
      // empty response and a failed setup both report zero too).
      let unsafePartial = false;
      if (redirectStub && existingBytes > 0) unsafePartial = !rollbackPartial(payload.partPath, existingBytes);
      // The zero-prefix case is NOT exempt. Nothing needs preserving, so the
      // whole file goes — but if the delete is denied the redirect body is
      // still on disk, and `resume` defaults to true, so the next attempt
      // appends the real download to it. Same corruption, same flag.
      else if (redirectStub) unsafePartial = !discardPart(payload.partPath);
      else discardEmptyPart(payload.partPath);

      // The marker goes on DISK, beside the file it describes. The status field
      // says the same thing, but a status is addressed by id — and a retry with
      // a new id, which is the normal case, never reads it. The one thing that
      // must not happen is the next attempt appending to these bytes.
      if (unsafePartial) markPartialUnsafe(payload.partPath);
      else recordPartialForResume();
      releasePath();

      const cancelled = error.code === "cancelled";
      const message = unsafePartial
        ? `${error.message} The partial file could not be cleaned up and must not be resumed; delete it before retrying.`
        : error.message;
      persist({
        state: cancelled ? "cancelled" : "failed",
        finishedAt: Date.now(),
        // Conditional spread, NOT `unsafePartial ? 0 : undefined`: persist does
        // `{ ...status, ...next }`, so an explicit undefined would overwrite a
        // real byte count — and readStatusFile rejects a status whose
        // bytesDownloaded is not finite, making the whole file unreadable.
        ...(unsafePartial ? { bytesDownloaded: 0, partialUnsafe: true } : {}),
        error: { code: error.code, message, httpStatus: error.httpStatus },
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
      // Genuine bytes, just not all of them — resumable, so record what they are.
      recordPartialForResume();
      releasePath();
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
      releasePath();
      process.exit(1);
      return;
    }

    // Publish atomically. `finalizing` is written FIRST so that a crash between
    // the rename and the completion write is recoverable: a reader seeing a dead
    // runner in `finalizing` with a correctly-sized final file reconciles it to
    // completed rather than reporting a spurious failure.
    // `totalBytes` is the value reconciliation compares against after a crash.
    // Advisory mode deliberately publishes a clean curl result even when a
    // caller's estimate differs, so record the bytes we are actually about to
    // publish rather than an expectation that advisory mode declined to enforce.
    persist({ state: "finalizing", bytesDownloaded: finalBytes, totalBytes: finalBytes });

    try {
      renameSync(payload.partPath, payload.outputPath);
    } catch (error) {
      // The rename failed, so the bytes are still in the `.part` file — and they
      // are a complete, correct copy. Record them: this is the one failure
      // where the partial is not partial.
      recordPartialForResume();
      releasePath();
      persist({
        state: "failed",
        finishedAt: Date.now(),
        error: { code: "permission", message: error instanceof Error ? error.message : String(error) },
      });
      process.exit(1);
      return;
    }

    // The partial became the finished file, so everything recorded about it
    // describes a path that no longer holds bytes. Cleared AFTER the rename:
    // until that lands, the state is still the truth about what is on disk.
    clearPartialState(payload.partPath);
    releasePath();

    persist({ state: "completed", finishedAt: Date.now(), bytesDownloaded: finalBytes, speedBytesPerSec: undefined, etaSeconds: undefined });
    // After the status write: a watching window should update immediately, and
    // a notification that hangs must not delay it.
    notify(payload, "Download Complete", payload.filename);
    process.exit(0);
  });
}

/**
 * The validators curl dumped for THIS attempt, or undefined if it never got a
 * response.
 *
 * The two cases must stay distinguishable: an empty object means "this response
 * carried no usable validator", which is an answer, while undefined means "no
 * response yet", which is not.
 */
function readValidators(partPath: string): { etag?: string; lastModified?: string } | undefined {
  try {
    return parseValidators(readFileSync(headerPath(partPath), "utf8"));
  } catch {
    return undefined;
  }
}

function discardHeaderDump(partPath: string): void {
  try {
    unlinkSync(headerPath(partPath));
  } catch {
    // Never written, or already gone.
  }
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
/** Roll a `.part` file back to the byte count it held before this attempt. */
/**
 * Remove a `.part` file outright, whatever it holds.
 *
 * Returns false when the file is still there afterwards. NOT best-effort-and-
 * forget: this runs on a partial holding a redirect body, and a caller that
 * ignores the outcome leaves contaminated bytes on disk with nothing recording
 * that they are contaminated — the next attempt resumes onto them.
 */
function discardPart(partPath: string): boolean {
  try {
    unlinkSync(partPath);
    return true;
  } catch {
    // Gone already is success; anything else means it is still there.
    return !existsSync(partPath);
  }
}

function discardEmptyPart(partPath: string): void {
  try {
    if (existsSync(partPath) && statSync(partPath).size === 0) unlinkSync(partPath);
  } catch {
    // Best effort: failing to tidy up must never fail the download's outcome.
  }
}

main();
