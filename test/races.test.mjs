/**
 * Cross-process races.
 *
 * Every Raycast command is a separate OS process with no shared memory, so the
 * defects these cover cannot be reproduced — or fixed — inside one process. The
 * tests here spawn real children and provoke real interleavings; a test that
 * asserted "a mutex object exists" would pass against every version of this
 * package, including the broken ones.
 *
 * Where a window is genuinely too narrow to hit from userland (two adjacent
 * syscalls), the test says so rather than pretending.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { killDownload, startDownload } from "../dist/detach.js";
import { createDownloadHistory } from "../dist/history.js";
import { acquireLease, isAlive, processStartTimeMs, readStatus, writeStatus } from "../dist/status.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => join(here, "fixtures", name);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "races-"));
}

async function waitFor(predicate, timeoutMs = 15_000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function exited(child) {
  return new Promise((resolve) => child.on("exit", resolve));
}

// ─── A. cross-process write races ────────────────────────────────────────────

test("acquireLease cannot roll a completed download back to downloading", async () => {
  // The defect: the command reads `downloading`, the runner writes `completed`,
  // the command writes its stale snapshot back — and a finished download
  // un-finishes, with a lease on it.
  //
  // The raw interleaving is the gap between two adjacent statements, which no
  // external process can time. So the child holds the status lock across the
  // moment it writes `completed`, which is the same hazard with a window wide
  // enough to observe: a correct `acquireLease` waits and then reads the final
  // state; the broken one reads straight past a writer mid-update.
  const dir = tempDir();
  try {
    const marker = join(dir, "ready");
    const child = spawn(process.execPath, [fixture("hold-status-lock.mjs"), dir, "lease-1", "600", marker], {
      stdio: "inherit",
    });
    // Attached NOW: `exit` fires once, and a listener added after the child has
    // already gone never hears it — which hangs the test rather than failing it.
    const childExited = exited(child);
    try {
      const ready = await waitFor(() => existsSync(marker));
      assert.ok(ready, "child never took the lock");

      const t0 = Date.now();
      const leased = acquireLease("lease-1", { ownerId: "A", dir });
      const elapsed = Date.now() - t0;

      assert.ok(leased, "the lease should be acquirable");
      assert.ok(
        elapsed >= 300,
        `acquireLease returned after ${elapsed}ms — it read straight through another process's update`,
      );
      assert.equal(leased.state, "completed", "the lease was granted on the runner's FINAL state");

      const onDisk = readStatus("lease-1", dir);
      assert.equal(onDisk.state, "completed", "completion must survive the lease write");
      assert.equal(onDisk.ownerId, "A", "and the lease must survive too");
    } finally {
      await childExited;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two processes adding history rows do not overwrite each other", async () => {
  // History is one storage key holding an array, so every mutation is
  // read-whole-array / write-whole-array. The in-process promise chain cannot
  // see another Raycast command doing the same thing, and the later write used
  // to erase the earlier row outright.
  const dir = tempDir();
  try {
    const storeFile = join(dir, "store.json");
    const marker = join(dir, "read");
    writeFileSync(storeFile, "{}");

    const child = spawn(
      process.execPath,
      [fixture("slow-history-add.mjs"), storeFile, dir, "child", "800", marker],
      { stdio: "inherit" },
    );
    const childExited = exited(child);

    try {
      assert.ok(await waitFor(() => existsSync(marker)), "child never read the history");

      // The child has read and has not written. A second process now adds a
      // different row — the exact overlap.
      const parentStorage = {
        async getItem(key) {
          return JSON.parse(readFileSync(storeFile, "utf8"))[key];
        },
        async setItem(key, value) {
          const all = JSON.parse(readFileSync(storeFile, "utf8"));
          all[key] = value;
          writeFileSync(storeFile, JSON.stringify(all));
        },
        async removeItem() {},
      };
      await createDownloadHistory({ storage: parentStorage, lockDir: dir }).add({
        id: "parent",
        filename: "parent.bin",
        outputPath: "/tmp/parent.bin",
        status: "completed",
      });

      await childExited;

      const rows = JSON.parse(JSON.parse(readFileSync(storeFile, "utf8"))["download-history"]);
      const ids = rows.map((r) => r.id).sort();
      assert.deepEqual(ids, ["child", "parent"], `both rows must survive; got ${JSON.stringify(ids)}`);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── B. process identity ─────────────────────────────────────────────────────

test("startDownload waits for the new attempt, not the previous failure", async () => {
  // Ids are reusable — that is how Retry works — so the previous attempt's
  // terminal status is still on disk when a retry starts. `startDownload` used
  // to accept it and resolve immediately, and the watcher the caller attached
  // the moment it resolved read the OLD failure and settled: press Retry, get
  // told instantly that it failed again.
  const dir = tempDir();
  try {
    const stale = {
      schema: 1,
      id: "retry-1",
      pid: 999_999,
      startedAtMs: Date.now() - 600_000,
      state: "failed",
      filename: "a.bin",
      outputPath: join(dir, "a.bin"),
      partPath: join(dir, "a.bin.part"),
      bytesDownloaded: 0,
      startedAt: Date.now() - 600_000,
      heartbeatAt: Date.now() - 600_000,
      error: { code: "http", message: "the previous attempt" },
    };
    writeStatus(stale, dir);

    const ticket = await startDownload({
      id: "retry-1",
      url: "https://127.0.0.1:9/never",
      outputPath: join(dir, "a.bin"),
      statusDir: dir,
      runnerPath: fixture("fake-runner.mjs"),
    });

    const settled = readStatus("retry-1", dir);
    assert.equal(settled.pid, ticket.pid, "the status startDownload settled on belongs to the new runner");
    assert.notEqual(settled.state, "failed", "the previous attempt's failure must not be what a watcher sees");
    assert.equal(settled.error, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelling does not escalate onto a replacement process that reused the id", async () => {
  // The grace period between SIGTERM and SIGKILL is long enough for the user to
  // press Retry. Re-reading the status file and killing whatever pid it now
  // names meant Cancel reached in and SIGKILLed the download that had just
  // started.
  const dir = tempDir();
  const spawnSurvivor = () =>
    spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
      detached: true,
      stdio: "ignore",
    });

  const original = spawnSurvivor();
  const replacement = spawnSurvivor();
  original.unref();
  replacement.unref();

  try {
    // Let both settle so `ps` can report their start times.
    await new Promise((r) => setTimeout(r, 300));

    const base = (pid) => ({
      schema: 1,
      id: "cancel-1",
      pid,
      startedAtMs: processStartTimeMs(pid),
      state: "downloading",
      filename: "a.bin",
      outputPath: join(dir, "a.bin"),
      partPath: join(dir, "a.bin.part"),
      bytesDownloaded: 5,
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
    });

    assert.ok(base(original.pid).startedAtMs, "need a verifiable start time for this test to mean anything");
    writeStatus(base(original.pid), dir);

    const cancelling = killDownload({ id: "cancel-1" }, { statusDir: dir, graceMs: 1500 });

    // Mid-grace: the retry writes its own attempt under the same id.
    await new Promise((r) => setTimeout(r, 250));
    writeStatus(base(replacement.pid), dir);

    await cancelling;

    let alive = true;
    try {
      process.kill(replacement.pid, 0);
    } catch {
      alive = false;
    }
    assert.ok(alive, "the replacement download was killed by the previous attempt's cancellation");

    const after = readStatus("cancel-1", dir);
    assert.equal(after.pid, replacement.pid);
    assert.equal(after.state, "downloading", "and it must not be labelled cancelled either");
  } finally {
    for (const child of [original, replacement]) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a runner that starts slowly still passes its own identity check", { skip: process.platform === "win32" }, async () => {
  // `(pid, startedAtMs)` is the identity every liveness and kill check compares,
  // with a 2s tolerance because `ps` reports whole seconds. Recording the
  // JavaScript-init timestamp instead of the OS process creation time meant a
  // cold Node start under load blew that tolerance: `isAlive` returned false
  // while bytes were still arriving, and a healthy transfer was reconciled as
  // abandoned mid-flight.
  //
  // The slow start is real, not simulated: NODE_OPTIONS=--require runs before
  // the runner's first line, so the gap between process creation and JS init is
  // an actual 3 seconds.
  const dir = tempDir();
  const slowInit = join(dir, "slow-init.cjs");
  writeFileSync(slowInit, "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);\n");

  // A server that trickles, so the download is still in flight when we look.
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Length": "200000", "Content-Type": "application/octet-stream" });
    const timer = setInterval(() => {
      if (!res.write(Buffer.alloc(2000, 0x61))) return;
    }, 50);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/slow.bin`;

  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${previous ? previous + " " : ""}--require ${slowInit}`;

  let ticket;
  try {
    ticket = await startDownload({
      id: "slowstart-1",
      url,
      outputPath: join(dir, "slow.bin"),
      statusDir: dir,
    });

    // Wait for a status the RUNNER wrote (the seed startDownload may have
    // written on timeout carries the correct value already, so it proves
    // nothing). Only the runner reports moving bytes.
    const fromRunner = await waitFor(() => {
      const status = readStatus("slowstart-1", dir);
      return status && status.bytesDownloaded > 0 ? status : null;
    }, 30_000);

    assert.ok(fromRunner, "the runner never reported progress");

    const actual = processStartTimeMs(fromRunner.pid);
    assert.ok(actual, "ps could not report the runner's start time");
    const skew = Math.abs(actual - fromRunner.startedAtMs);
    assert.ok(
      skew < 2000,
      `startedAtMs is ${skew}ms from the OS process start time — outside the identity tolerance`,
    );
    assert.equal(isAlive(fromRunner), true, "a live runner must not fail its own identity check");
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    if (ticket) await killDownload(ticket, { statusDir: dir, graceMs: 200 });
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
