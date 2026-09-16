import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { killDownload, reconcile, startDownload } from "../dist/detach.js";
import {
  listStatuses,
  processStartTimeMs,
  pruneStatuses,
  readStatus,
  writeStatus,
} from "../dist/status.js";

const distStatus = fileURLToPath(new URL("../dist/status.js", import.meta.url));
const require = createRequire(import.meta.url);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "lifecycle-test-"));
}

function status(id, dir, overrides = {}) {
  const now = Date.now();
  return {
    schema: 1,
    id,
    pid: process.pid,
    startedAtMs: processStartTimeMs(process.pid) ?? now,
    state: "downloading",
    filename: "download.bin",
    outputPath: join(dir, "download.bin"),
    partPath: join(dir, "download.bin.part"),
    bytesDownloaded: 1,
    startedAt: now,
    heartbeatAt: now,
    ...overrides,
  };
}

function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (predicate() || Date.now() >= deadline) {
        clearInterval(timer);
        resolve(predicate());
      }
    }, 10);
  });
}

function exited(child) {
  return new Promise((resolve) => child.once("exit", resolve));
}

function lockThenReplace(dir, id, marker, replacement) {
  const code = `
    import { withStatusLock, writeStatus, processStartTimeMs } from ${JSON.stringify(distStatus)};
    import { writeFileSync } from "node:fs";
    withStatusLock(${JSON.stringify(id)}, ${JSON.stringify(dir)}, () => {
      writeFileSync(${JSON.stringify(marker)}, "locked");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      const now = Date.now();
      writeStatus({ ...${JSON.stringify(replacement)}, pid: process.pid, startedAtMs: processStartTimeMs(process.pid) ?? now, startedAt: now, heartbeatAt: now, state: "downloading" }, ${JSON.stringify(dir)});
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    });
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "inherit" });
}

test("pruneStatuses rechecks the attempt under its status lock before deleting", async () => {
  const dir = tempDir();
  try {
    const old = status("prune-race", dir, { pid: 999_999, startedAtMs: 1, startedAt: 1, heartbeatAt: 1 });
    writeStatus(old, dir);
    writeFileSync(old.partPath, "x");
    const marker = join(dir, "locked");
    const child = lockThenReplace(dir, old.id, marker, old);
    const done = exited(child);
    assert.ok(await waitFor(() => existsSync(marker)), "child never took the status lock");

    pruneStatuses({ dir, now: Date.now(), olderThanMs: 1_000 });
    await done;

    assert.equal(readStatus(old.id, dir)?.state, "downloading");
    assert.ok(existsSync(old.partPath), "a retry's partial file was reaped from an old snapshot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcile rechecks a supplied old attempt under the status lock", async () => {
  const dir = tempDir();
  try {
    const old = status("reconcile-race", dir, { pid: 999_999, startedAtMs: 1, state: "finalizing" });
    writeStatus(old, dir);
    const marker = join(dir, "locked");
    const child = lockThenReplace(dir, old.id, marker, old);
    const done = exited(child);
    assert.ok(await waitFor(() => existsSync(marker)), "child never took the status lock");

    const result = reconcile(old, dir);
    await done;

    assert.equal(result.state, "downloading", "reconcile returned a terminal state from the stale attempt");
    assert.equal(readStatus(old.id, dir)?.state, "downloading");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("killDownload refuses a ticket whose pid no longer owns the id", async () => {
  const dir = tempDir();
  const retry = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  retry.unref();
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    // This sandbox does not expose `ps` for detached children. Make the
    // identity probe deterministic while retaining the real process tree that
    // the broken implementation would signal.
    const childProcess = require("node:child_process");
    const originalExecFileSync = childProcess.execFileSync;
    childProcess.execFileSync = () => new Date().toString();
    try {
      writeStatus(status("cancel-retry", dir, { pid: retry.pid, startedAtMs: Date.now() }), dir);
      assert.equal(await killDownload({ id: "cancel-retry", pid: 999_999 }, { statusDir: dir, graceMs: 50 }), false);
    } finally {
      childProcess.execFileSync = originalExecFileSync;
    }
    assert.doesNotThrow(() => process.kill(retry.pid, 0), "the retry was signalled by a stale ticket");
  } finally {
    try {
      process.kill(-retry.pid, "SIGKILL");
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("killDownload preserves an existing terminal failure", async () => {
  const dir = tempDir();
  try {
    const failed = status("failed-cancel", dir, {
      pid: 999_999,
      startedAtMs: 1,
      state: "failed",
      error: { code: "dns", message: "host not found" },
    });
    writeStatus(failed, dir);
    assert.equal(await killDownload({ id: failed.id, pid: failed.pid }, { statusDir: dir }), false);
    assert.deepEqual(readStatus(failed.id, dir)?.error, failed.error);
    assert.equal(readStatus(failed.id, dir)?.state, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a heartbeat cannot overwrite a terminal state, while a new attempt can reuse the id", () => {
  const dir = tempDir();
  try {
    const completed = status("monotonic", dir, { state: "completed", finishedAt: Date.now() });
    writeStatus(completed, dir);
    writeStatus({ ...completed, state: "downloading", finishedAt: undefined, heartbeatAt: Date.now() + 1 }, dir);
    assert.equal(readStatus(completed.id, dir)?.state, "completed");

    writeStatus({ ...completed, pid: completed.pid + 1, startedAtMs: completed.startedAtMs + 10_000, state: "starting", finishedAt: undefined }, dir);
    assert.equal(readStatus(completed.id, dir)?.state, "starting");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status readers reject schema-1 records without process identity fields", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "invalid.json"), JSON.stringify({ schema: 1, id: "invalid", state: "downloading" }));
    assert.equal(readStatus("invalid", dir), null);
    assert.deepEqual(listStatuses(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing-runner guidance names the standalone bundle", async () => {
  const dir = tempDir();
  try {
    await assert.rejects(
      startDownload({ id: "missing-runner", url: "https://example.test/file", outputPath: join(dir, "file"), runnerPath: join(dir, "nope.js") }),
      (error) =>
        error.message.includes("copy the package's dist/runner.bundle.js next to the bundle") &&
        !error.message.includes("copy the package's dist/runner.js next to the bundle"),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
