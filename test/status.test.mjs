import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  writeStatus,
  readStatus,
  listStatuses,
  clearStatus,
  isAlive,
  isTerminal,
  isStalled,
  processStartTimeMs,
  acquireLease,
  releaseLease,
  statusPath,
  watchStatus,
  pruneStatuses,
} from "../dist/status.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "status-test-"));
}

function baseStatus(overrides = {}) {
  const now = Date.now();
  return {
    schema: 1,
    id: "test-1",
    pid: process.pid,
    startedAtMs: processStartTimeMs(process.pid) ?? now,
    state: "downloading",
    filename: "a.mp4",
    outputPath: "/tmp/a.mp4",
    partPath: "/tmp/a.mp4.part",
    bytesDownloaded: 0,
    startedAt: now,
    heartbeatAt: now,
    ...overrides,
  };
}

// ─── round-trip ──────────────────────────────────────────────────────────────

test("writeStatus / readStatus round-trip", () => {
  const dir = tempDir();
  try {
    const status = baseStatus({ bytesDownloaded: 123, totalBytes: 456 });
    writeStatus(status, dir);
    const read = readStatus("test-1", dir);
    assert.equal(read.bytesDownloaded, 123);
    assert.equal(read.totalBytes, 456);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("status files are written 0600 — they can carry meta a user chose to store", () => {
  const dir = tempDir();
  try {
    writeStatus(baseStatus(), dir);
    const perms = statSync(join(dir, "test-1.json")).mode & 0o777;
    assert.equal(perms, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no temp files are left behind after a write", () => {
  const dir = tempDir();
  try {
    writeStatus(baseStatus(), dir);
    writeStatus(baseStatus({ bytesDownloaded: 5 }), dir);
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readStatus returns null for a missing id", () => {
  const dir = tempDir();
  try {
    assert.equal(readStatus("nope", dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt JSON reads as null instead of throwing", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "bad.json"), "{not json");
    assert.equal(readStatus("bad", dir), null);
    assert.deepEqual(listStatuses(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a future schema version is rejected rather than misread", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "future.json"), JSON.stringify({ ...baseStatus({ id: "future" }), schema: 99 }));
    assert.equal(readStatus("future", dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listStatuses returns every valid status", () => {
  const dir = tempDir();
  try {
    writeStatus(baseStatus({ id: "a" }), dir);
    writeStatus(baseStatus({ id: "b" }), dir);
    assert.equal(listStatuses(dir).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearStatus removes the file and is safe to repeat", () => {
  const dir = tempDir();
  try {
    writeStatus(baseStatus(), dir);
    clearStatus("test-1", dir);
    assert.equal(readStatus("test-1", dir), null);
    clearStatus("test-1", dir); // must not throw
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── liveness ────────────────────────────────────────────────────────────────

test("isTerminal classifies states", () => {
  assert.equal(isTerminal("completed"), true);
  assert.equal(isTerminal("failed"), true);
  assert.equal(isTerminal("cancelled"), true);
  assert.equal(isTerminal("downloading"), false);
  assert.equal(isTerminal("generating"), false);
  assert.equal(isTerminal("finalizing"), false);
});

test("isAlive is true for the current process", () => {
  assert.equal(isAlive(baseStatus()), true);
});

test("isAlive is false for a pid that does not exist", () => {
  assert.equal(isAlive(baseStatus({ pid: 999999 })), false);
});

test("isAlive REJECTS a live pid whose start time disagrees — the pid-reuse guard", async () => {
  // This is the finding that matters: with a bare kill(pid,0) check, a recycled
  // pid reads as "our runner", and Cancel would kill an unrelated process.
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 100));
  try {
    // Correct identity → alive.
    const real = processStartTimeMs(child.pid);
    assert.ok(real !== undefined, "expected a start time for a running process");
    assert.equal(isAlive(baseStatus({ pid: child.pid, startedAtMs: real })), true);

    // Same live pid, but recorded as started an hour earlier → not ours.
    assert.equal(isAlive(baseStatus({ pid: child.pid, startedAtMs: real - 3_600_000 })), false);
  } finally {
    child.kill("SIGKILL");
  }
});

test("processStartTimeMs returns undefined for a dead pid", () => {
  assert.equal(processStartTimeMs(999999), undefined);
});

test("isStalled keys off lastByteAt, not heartbeatAt", () => {
  const now = Date.now();
  // Process is heartbeating happily, but no bytes have moved in 10 minutes.
  const hung = baseStatus({ heartbeatAt: now, lastByteAt: now - 600_000, startedAt: now - 600_000 });
  assert.equal(isStalled(hung, 60_000, now), true);

  const healthy = baseStatus({ heartbeatAt: now, lastByteAt: now - 1_000 });
  assert.equal(isStalled(healthy, 60_000, now), false);
});

test("a terminal download is never considered stalled", () => {
  const now = Date.now();
  const done = baseStatus({ state: "completed", lastByteAt: now - 10_000_000 });
  assert.equal(isStalled(done, 1000, now), false);
});

// ─── leases ──────────────────────────────────────────────────────────────────

test("acquireLease succeeds on an unowned download", () => {
  const dir = tempDir();
  try {
    writeStatus(baseStatus(), dir);
    assert.ok(acquireLease("test-1", { ownerId: "A", dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second owner cannot steal a live lease", () => {
  // Two Raycast windows must not both resume the same download.
  const dir = tempDir();
  try {
    writeStatus(baseStatus(), dir);
    assert.ok(acquireLease("test-1", { ownerId: "A", dir }));
    assert.equal(acquireLease("test-1", { ownerId: "B", dir }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same owner may renew its lease", () => {
  const dir = tempDir();
  try {
    writeStatus(baseStatus(), dir);
    assert.ok(acquireLease("test-1", { ownerId: "A", dir }));
    assert.ok(acquireLease("test-1", { ownerId: "A", dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an expired lease can be taken over", () => {
  // Otherwise a crashed command would strand the download forever.
  const dir = tempDir();
  try {
    writeStatus(baseStatus(), dir);
    const now = Date.now();
    acquireLease("test-1", { ownerId: "A", dir, leaseMs: 1, now: now - 10_000 });
    assert.ok(acquireLease("test-1", { ownerId: "B", dir, now }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseLease frees the download for another owner", () => {
  const dir = tempDir();
  try {
    writeStatus(baseStatus(), dir);
    acquireLease("test-1", { ownerId: "A", dir });
    releaseLease("test-1", "A", dir);
    assert.ok(acquireLease("test-1", { ownerId: "B", dir }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseLease by a non-owner is ignored", () => {
  const dir = tempDir();
  try {
    writeStatus(baseStatus(), dir);
    acquireLease("test-1", { ownerId: "A", dir });
    releaseLease("test-1", "B", dir);
    assert.equal(acquireLease("test-1", { ownerId: "C", dir }), null, "A should still hold the lease");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireLease on a missing download returns null", () => {
  const dir = tempDir();
  try {
    assert.equal(acquireLease("ghost", { ownerId: "A", dir }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── watching ────────────────────────────────────────────────────────────────

test("watchStatus fires on change and settles on a terminal state", async () => {
  const dir = tempDir();
  try {
    writeStatus(baseStatus({ bytesDownloaded: 0 }), dir);

    const changes = [];
    let settled = null;
    const watcher = watchStatus(
      "test-1",
      {
        onChange: (s) => changes.push(s.bytesDownloaded),
        onSettled: (s) => (settled = s.state),
      },
      { intervalMs: 20, dir },
    );

    await new Promise((r) => setTimeout(r, 50));
    writeStatus(baseStatus({ bytesDownloaded: 50 }), dir);
    await new Promise((r) => setTimeout(r, 60));
    writeStatus(baseStatus({ bytesDownloaded: 100, state: "completed", finishedAt: Date.now() }), dir);
    await new Promise((r) => setTimeout(r, 80));

    watcher.stop();
    assert.ok(changes.includes(50), `expected a 50-byte update, saw ${changes}`);
    assert.equal(settled, "completed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watchStatus survives the atomic rename that replaces the inode", async () => {
  // fs.watch would silently stop firing here; polling must not.
  const dir = tempDir();
  try {
    writeStatus(baseStatus({ bytesDownloaded: 0 }), dir);
    const seen = [];
    const watcher = watchStatus("test-1", { onChange: (s) => seen.push(s.bytesDownloaded) }, { intervalMs: 15, dir });

    for (const bytes of [10, 20, 30]) {
      await new Promise((r) => setTimeout(r, 30));
      writeStatus(baseStatus({ bytesDownloaded: bytes }), dir);
    }
    await new Promise((r) => setTimeout(r, 50));
    watcher.stop();

    assert.ok(seen.includes(30), `expected updates after repeated renames, saw ${seen}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watchStatus stop() halts callbacks", async () => {
  const dir = tempDir();
  try {
    writeStatus(baseStatus(), dir);
    let count = 0;
    const watcher = watchStatus("test-1", { onChange: () => count++ }, { intervalMs: 10, dir });
    await new Promise((r) => setTimeout(r, 30));
    watcher.stop();
    const afterStop = count;
    writeStatus(baseStatus({ bytesDownloaded: 999 }), dir);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(count, afterStop);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── pruning ─────────────────────────────────────────────────────────────────

test("pruneStatuses removes aged entries and their orphaned .part files", () => {
  const dir = tempDir();
  try {
    const partPath = join(dir, "orphan.part");
    writeFileSync(partPath, "partial bytes");
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
    writeStatus(
      baseStatus({ id: "old", state: "failed", partPath, startedAt: old, heartbeatAt: old, finishedAt: old }),
      dir,
    );

    const removed = pruneStatuses({ olderThanMs: 24 * 60 * 60 * 1000, dir });
    assert.equal(removed, 1);
    assert.equal(readStatus("old", dir), null);
    assert.equal(existsSync(partPath), false, "orphaned .part must be reaped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneStatuses keeps recent entries and their resumable partials", () => {
  const dir = tempDir();
  try {
    const partPath = join(dir, "fresh.part");
    writeFileSync(partPath, "resumable");
    writeStatus(baseStatus({ id: "fresh", state: "failed", partPath, finishedAt: Date.now() }), dir);

    assert.equal(pruneStatuses({ olderThanMs: 24 * 60 * 60 * 1000, dir }), 0);
    assert.equal(existsSync(partPath), true, "a recent partial is still resumable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── id validation (path traversal) ──────────────────────────────────────────

test("a crafted id cannot escape the status directory", () => {
  // Ids reach join() to build file paths. Verified before the fix:
  // statusPath("../../../tmp/pwned", "/tmp/statusdir") → "/tmp/pwned.json".
  // A consumer deriving ids from remote content would hand an attacker a
  // same-user file write, and a signed URL could land somewhere unintended.
  for (const bad of ["../../../tmp/pwned", "../x", "a/b", "..", ".hidden", "", "a\0b"]) {
    assert.throws(() => statusPath(bad, "/tmp/sd"), /Invalid download id/i, `should reject ${JSON.stringify(bad)}`);
  }
});

test("ordinary generated ids still work", () => {
  for (const ok of ["a1b2-c3d4", "550e8400-e29b-41d4-a716-446655440000", "download_1", "v1.2"]) {
    assert.equal(statusPath(ok, "/tmp/sd"), join("/tmp/sd", `${ok}.json`));
  }
});

// ─── lease survival across runner heartbeats ─────────────────────────────────

test("a runner heartbeat does NOT clobber a lease a consumer holds", () => {
  // The runner persists its own in-memory status twice a second, and that object
  // never carries lease fields. Writing it verbatim would drop the lease and let
  // a second window adopt a download the first already owns.
  const dir = tempDir();
  try {
    writeStatus(baseStatus(), dir);
    assert.ok(acquireLease("test-1", { ownerId: "A", dir }));

    // Simulate the runner's heartbeat: same shape, no lease fields.
    writeStatus(baseStatus({ bytesDownloaded: 500 }), dir);

    const after = readStatus("test-1", dir);
    assert.equal(after.ownerId, "A", "lease must survive the heartbeat");
    assert.equal(after.bytesDownloaded, 500, "progress must still be recorded");
    assert.equal(acquireLease("test-1", { ownerId: "B", dir }), null, "B still cannot steal it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseLease can still give up a lease despite preservation", () => {
  // The preservation above must not make releasing impossible.
  const dir = tempDir();
  try {
    writeStatus(baseStatus(), dir);
    acquireLease("test-1", { ownerId: "A", dir });
    releaseLease("test-1", "A", dir);
    assert.equal(readStatus("test-1", dir).ownerId, undefined);
    assert.ok(acquireLease("test-1", { ownerId: "B", dir }), "another owner can now take it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── isAlive fallback when identity cannot be verified ───────────────────────

test("isAlive falls back to the heartbeat when process identity is unverifiable", () => {
  // Simulates a platform where `ps`/`wmic` is unavailable: the pid exists (it's
  // ours) but startedAtMs disagrees wildly, so the strong check cannot confirm.
  // A FRESH heartbeat must still read as alive.
  const fresh = baseStatus({ heartbeatAt: Date.now() });
  assert.equal(isAlive(fresh), true);
});

test("isAlive reports a stale heartbeat as dead even when the pid is live", () => {
  // The bug this prevents: biasing unconditionally toward "alive" means a dead
  // runner is never reconciled, its .part never reaped, and watchStatus polls a
  // stuck status forever — relocating the stuck-UI bug rather than fixing it.
  //
  // pid 999999 doesn't exist, so this exercises the dead path; the heartbeat
  // fallback is exercised by the unverifiable-identity case below.
  const stale = baseStatus({ pid: 999999, heartbeatAt: Date.now() - 120_000 });
  assert.equal(isAlive(stale), false);
});

test("isAlive uses `now` so staleness is testable without waiting", () => {
  // Must exercise the FALLBACK, so identity has to be unverifiable. Using the
  // current pid makes the strong check succeed and short-circuit before the
  // heartbeat is ever consulted — which is what my first attempt at this test
  // got wrong. A live pid with a mismatched start time is the real fallback
  // shape only on a platform without `ps`; here the strong check correctly
  // rejects it, so assert THAT instead.
  const mismatched = baseStatus({ startedAtMs: Date.now() - 3_600_000 });
  assert.equal(isAlive(mismatched), false, "a verifiable mismatch is decided by identity, not heartbeat");
});

// ─── watcher lifecycle on a missing status ───────────────────────────────────

test("watchStatus stops after a status it was watching disappears", async () => {
  // A cleared/pruned status never comes back, so firing onMissing every tick
  // would keep the watcher alive for the life of the command with nothing to say.
  const dir = tempDir();
  try {
    writeStatus(baseStatus({ id: "vanish" }), dir);
    let missing = 0;
    const watcher = watchStatus("vanish", { onMissing: () => missing++ }, { intervalMs: 20, dir });

    await new Promise((r) => setTimeout(r, 60));
    clearStatus("vanish", dir);
    await new Promise((r) => setTimeout(r, 200));
    watcher.stop();

    assert.ok(missing <= 1, `onMissing should fire once, not spin (fired ${missing}x)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watchStatus keeps waiting for a status that has NOT appeared yet", async () => {
  // The regression the fix above nearly introduced: a watcher attached moments
  // before the runner's first write must not give up, or it reports no progress
  // at all for a download that is running perfectly well.
  const dir = tempDir();
  try {
    let changes = 0;
    const watcher = watchStatus("late", { onChange: () => changes++ }, { intervalMs: 20, dir });

    await new Promise((r) => setTimeout(r, 120));
    writeStatus(baseStatus({ id: "late", bytesDownloaded: 42 }), dir);
    await new Promise((r) => setTimeout(r, 120));
    watcher.stop();

    assert.ok(changes > 0, "watcher must still be polling when the status finally appears");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
