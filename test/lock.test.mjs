/** Regression tests for ownership and lifetime of the cross-process lock. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { withFileLock, withFileLockSync } from "../dist/lock.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "lock-"));
}

function waitFor(predicate, timeoutMs = 2_000, intervalMs = 10) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        resolve(false);
      }
    }, intervalMs);
  });
}

function exited(child) {
  return new Promise((resolve) => child.once("exit", resolve));
}

function node(script, ...args) {
  return spawn(process.execPath, ["-e", script, ...args], { stdio: "inherit" });
}

test("a stale lock with a recycled live pid is recoverable", () => {
  const dir = tempDir();
  const recycled = join(dir, "recycled.lock");
  const old = new Date(Date.now() - 5_000);
  try {
    // This is the post-PID-recycle state: the PID currently belongs to this
    // live test process, but the start time came from its dead predecessor.
    writeFileSync(recycled, `${process.pid} recycled-owner 1\n`);
    utimesSync(recycled, old, old);
    const recoveredAt = Date.now();
    withFileLockSync(recycled, () => undefined, { staleMs: 20, waitMs: 180, pollMs: 5 });
    assert.ok(Date.now() - recoveredAt < 120, "recycled pid lock waited instead of being recovered");
    assert.equal(existsSync(recycled), false, "recycled pid lock was left in place");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale stealer does not remove a replacement lock", async () => {
  const dir = tempDir();
  const lock = join(dir, "shared.lock");
  const poised = join(dir, "poised");
  try {
    // This is the real cross-process interleaving from the defect: a stealer
    // observes an old lock, its owner releases it, another process takes it,
    // and only then the stealer verifies staleness. The preload widens only
    // the otherwise-adjacent read/stat window; the lock operations are real.
    writeFileSync(lock, "old-owner");
    const child = node(
      `const fs = require("node:fs");
       const original = fs.statSync;
       fs.statSync = (path) => { fs.writeFileSync(process.argv[1], "poised"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120); return original(path); };
       const { withFileLockSync } = require(process.argv[2]);
       const start = Date.now();
       withFileLockSync(process.argv[3], () => fs.writeFileSync(process.argv[4], String(Date.now() - start)), { staleMs: 0, waitMs: 600, pollMs: 5 });`,
      poised,
      join(process.cwd(), "dist/lock.js"),
      lock,
      join(dir, "elapsed"),
    );
    const childDone = exited(child);
    assert.ok(await waitFor(() => existsSync(poised)), "stealer never reached stale-lock removal");

    unlinkSync(lock); // the old owner releases
    writeFileSync(lock, "replacement-owner"); // a new owner acquires
    // It has been held long enough to be a valid stale-steal candidate. The
    // ownership check, not a fresh mtime, must be what protects it.
    const old = new Date(Date.now() - 5_000);
    utimesSync(lock, old, old);
    setTimeout(() => {
      try {
        unlinkSync(lock);
      } catch {
        // The broken stealer already removed it.
      }
    }, 250);

    await childDone;
    const elapsed = Number(readFileSync(join(dir, "elapsed"), "utf8"));
    assert.ok(elapsed >= 180, `stealer entered after ${elapsed}ms by deleting the replacement lock`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live async holder remains exclusive beyond staleMs", async () => {
  const dir = tempDir();
  const lock = join(dir, "shared.lock");
  const ready = join(dir, "ready");
  try {
    const child = node(
      `const fs = require("node:fs"); const { withFileLock } = require(process.argv[2]);
       withFileLock(process.argv[1], async () => { fs.writeFileSync(process.argv[3], "ready"); await new Promise((r) => setTimeout(r, 260)); }, { staleMs: 40, waitMs: 600, pollMs: 5 });`,
      lock,
      join(process.cwd(), "dist/lock.js"),
      ready,
    );
    const childDone = exited(child);
    assert.ok(await waitFor(() => existsSync(ready)), "holder never acquired the lock");
    const start = Date.now();
    await withFileLock(lock, async () => undefined, { staleMs: 40, waitMs: 600, pollMs: 5 });
    const elapsed = Date.now() - start;
    await childDone;
    assert.ok(elapsed >= 180, `live holder was stolen after ${elapsed}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a displaced holder cannot release its successor's lock", async () => {
  const dir = tempDir();
  const lock = join(dir, "shared.lock");
  const ready = join(dir, "ready");
  try {
    const first = node(
      `const fs = require("node:fs"); const { withFileLock } = require(process.argv[2]);
       withFileLock(process.argv[1], async () => { fs.writeFileSync(process.argv[3], "ready"); await new Promise((r) => setTimeout(r, 150)); });`,
      lock,
      join(process.cwd(), "dist/lock.js"),
      ready,
    );
    const firstDone = exited(first);
    assert.ok(await waitFor(() => existsSync(ready)), "first holder never acquired the lock");

    // Simulate stale-lock recovery replacing the pathname while the original
    // owner is still in its critical section. The successor is a real child
    // holding the pathname until after the original owner exits.
    unlinkSync(lock);
    const successor = node(
      `const fs = require("node:fs"); const fd = fs.openSync(process.argv[1], "wx"); fs.writeFileSync(process.argv[2], "ready"); setTimeout(() => { fs.closeSync(fd); try { fs.unlinkSync(process.argv[1]); } catch {} }, 300);`,
      lock,
      join(dir, "successor-ready"),
    );
    const successorDone = exited(successor);
    assert.ok(await waitFor(() => existsSync(join(dir, "successor-ready"))), "successor never acquired the lock");
    await firstDone;

    const start = Date.now();
    await withFileLock(lock, async () => undefined, { waitMs: 600, pollMs: 5 });
    const elapsed = Date.now() - start;
    await successorDone;
    assert.ok(elapsed >= 100, `displaced release deleted its successor after ${elapsed}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent async callers on one path serialize", async () => {
  const dir = tempDir();
  const lock = join(dir, "shared.lock");
  let releaseFirst;
  const firstMayFinish = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted;
  const firstHasStarted = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const events = [];
  try {
    const first = withFileLock(lock, async () => {
      events.push("first-start");
      firstStarted();
      await firstMayFinish;
      events.push("first-end");
    });
    await firstHasStarted;
    const second = withFileLock(lock, async () => {
      events.push("second-start");
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(events, ["first-start"], "second caller entered while the first awaited");
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first-start", "first-end", "second-start"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
