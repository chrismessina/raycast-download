import assert from "node:assert/strict";
import { test } from "node:test";

import { createDownloadHistory } from "../dist/history.js";

/** In-memory stand-in for Raycast's LocalStorage. */
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    async getItem(key) {
      return data.get(key);
    },
    async setItem(key, value) {
      data.set(key, value);
    },
    async removeItem(key) {
      data.delete(key);
    },
    _raw: data,
  };
}

test("add then list round-trips a record", async () => {
  const history = createDownloadHistory({ storage: memoryStorage() });
  await history.add({ id: "1", filename: "a.mp4", outputPath: "/tmp/a.mp4", status: "completed" });

  const rows = await history.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "1");
  assert.ok(typeof rows[0].timestamp === "number");
});

test("list returns newest first", async () => {
  const history = createDownloadHistory({ storage: memoryStorage() });
  await history.add({ id: "old", filename: "o", outputPath: "/tmp/o", status: "completed", timestamp: 1000 });
  await history.add({ id: "new", filename: "n", outputPath: "/tmp/n", status: "completed", timestamp: 2000 });

  const rows = await history.list();
  assert.deepEqual(
    rows.map((r) => r.id),
    ["new", "old"],
  );
});

test("adding the same id replaces rather than duplicates", async () => {
  // Resume-on-reopen can report a download that history already recorded.
  // Appending would make the list claim it happened twice.
  const history = createDownloadHistory({ storage: memoryStorage() });
  await history.add({ id: "x", filename: "a.mp4", outputPath: "/tmp/a", status: "failed", timestamp: 1 });
  await history.add({ id: "x", filename: "a.mp4", outputPath: "/tmp/a", status: "completed", timestamp: 2 });

  const rows = await history.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "completed");
});

test("limit caps retained rows, keeping the newest", async () => {
  const history = createDownloadHistory({ storage: memoryStorage(), limit: 3 });
  for (let i = 0; i < 10; i++) {
    await history.add({ id: `${i}`, filename: `f${i}`, outputPath: `/tmp/${i}`, status: "completed", timestamp: i });
  }

  const rows = await history.list();
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["9", "8", "7"],
  );
});

test("dedupeBy collapses rows sharing a key, keeping the newest", async () => {
  // iOS Apps wants one row per app, not per download.
  const history = createDownloadHistory({
    storage: memoryStorage(),
    dedupeBy: (r) => r.meta?.bundleId,
  });
  await history.add({
    id: "1",
    filename: "a",
    outputPath: "/tmp/a",
    status: "completed",
    timestamp: 1,
    meta: { bundleId: "com.x" },
  });
  await history.add({
    id: "2",
    filename: "b",
    outputPath: "/tmp/b",
    status: "completed",
    timestamp: 2,
    meta: { bundleId: "com.x" },
  });

  const rows = await history.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "2");
});

test("dedupeBy exempts rows returning undefined", async () => {
  const history = createDownloadHistory({
    storage: memoryStorage(),
    dedupeBy: (r) => r.meta?.bundleId,
  });
  await history.add({ id: "1", filename: "a", outputPath: "/tmp/a", status: "completed", timestamp: 1 });
  await history.add({ id: "2", filename: "b", outputPath: "/tmp/b", status: "completed", timestamp: 2 });

  const rows = await history.list();
  assert.equal(rows.length, 2, "rows without a dedupe key must all survive");
});

test("addMany preserves input order", async () => {
  const history = createDownloadHistory({ storage: memoryStorage() });
  await history.addMany([
    { id: "first", filename: "1", outputPath: "/tmp/1", status: "completed" },
    { id: "second", filename: "2", outputPath: "/tmp/2", status: "completed" },
    { id: "third", filename: "3", outputPath: "/tmp/3", status: "completed" },
  ]);

  const rows = await history.list();
  assert.deepEqual(
    rows.map((r) => r.id),
    ["first", "second", "third"],
  );
});

test("addMany with an empty array is a no-op", async () => {
  const storage = memoryStorage();
  const history = createDownloadHistory({ storage });
  await history.addMany([]);
  assert.equal((await history.list()).length, 0);
});

test("remove deletes one row", async () => {
  const history = createDownloadHistory({ storage: memoryStorage() });
  await history.add({ id: "1", filename: "a", outputPath: "/tmp/a", status: "completed" });
  await history.add({ id: "2", filename: "b", outputPath: "/tmp/b", status: "completed" });
  await history.remove("1");

  const rows = await history.list();
  assert.deepEqual(
    rows.map((r) => r.id),
    ["2"],
  );
});

test("clear empties the store", async () => {
  const history = createDownloadHistory({ storage: memoryStorage() });
  await history.add({ id: "1", filename: "a", outputPath: "/tmp/a", status: "completed" });
  await history.clear();
  assert.equal((await history.list()).length, 0);
});

test("clearOlderThan drops aged rows and reports the count", async () => {
  const history = createDownloadHistory({ storage: memoryStorage() });
  const now = Date.now();
  await history.add({ id: "fresh", filename: "f", outputPath: "/tmp/f", status: "completed", timestamp: now });
  await history.add({
    id: "stale",
    filename: "s",
    outputPath: "/tmp/s",
    status: "completed",
    timestamp: now - 10 * 24 * 60 * 60 * 1000,
  });

  const removed = await history.clearOlderThan(24 * 60 * 60 * 1000);
  assert.equal(removed, 1);
  assert.deepEqual((await history.list()).map((r) => r.id), ["fresh"]);
});

test("corrupt stored JSON yields an empty list instead of throwing", async () => {
  // An unreadable history is recoverable; a crash on command launch is not.
  const history = createDownloadHistory({ storage: memoryStorage({ "download-history": "{not json" }) });
  assert.deepEqual(await history.list(), []);
});

test("non-array stored JSON is ignored", async () => {
  const history = createDownloadHistory({ storage: memoryStorage({ "download-history": '{"a":1}' }) });
  assert.deepEqual(await history.list(), []);
});

test("a custom key isolates two histories in one extension", async () => {
  const storage = memoryStorage();
  const a = createDownloadHistory({ storage, key: "hist-a" });
  const b = createDownloadHistory({ storage, key: "hist-b" });

  await a.add({ id: "1", filename: "a", outputPath: "/tmp/a", status: "completed" });
  assert.equal((await a.list()).length, 1);
  assert.equal((await b.list()).length, 0);
});

// ─── reconcileHistory ────────────────────────────────────────────────────────
// The gap this closes is structural: the detached runner finishes the download
// but cannot write to LocalStorage, and the command that could has been
// unloaded. Nothing records the row at completion time — so the next launch
// folds terminal status files into history.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileHistory } from "../dist/history.js";
import { writeStatus, readStatus, listStatuses } from "../dist/status.js";

function statusFixture(overrides = {}) {
  const now = Date.now();
  return {
    schema: 1,
    id: "rec-1",
    pid: process.pid,
    startedAtMs: now,
    state: "completed",
    filename: "a.mp4",
    outputPath: "/tmp/a.mp4",
    partPath: "/tmp/a.mp4.part",
    bytesDownloaded: 100,
    totalBytes: 100,
    startedAt: now,
    heartbeatAt: now,
    finishedAt: now,
    ...overrides,
  };
}

test("reconcileHistory folds a completed download the command never saw finish", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recon-"));
  try {
    writeStatus(statusFixture(), dir);
    const history = createDownloadHistory({ storage: memoryStorage() });

    assert.equal(await reconcileHistory(history, { statusDir: dir }), 1);

    const rows = await history.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, "rec-1");
    assert.equal(rows[0].status, "completed");
    assert.equal(rows[0].bytesDownloaded, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcileHistory clears the status file so it is not folded twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recon-once-"));
  try {
    writeStatus(statusFixture(), dir);
    const history = createDownloadHistory({ storage: memoryStorage() });

    await reconcileHistory(history, { statusDir: dir });
    assert.equal(readStatus("rec-1", dir), null, "status must be cleared");

    // A second pass has nothing to do, and must not duplicate the row.
    assert.equal(await reconcileHistory(history, { statusDir: dir }), 0);
    assert.equal((await history.list()).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcileHistory carries failure detail through", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recon-fail-"));
  try {
    writeStatus(
      statusFixture({ id: "bad", state: "failed", error: { code: "http_server", message: "500" } }),
      dir,
    );
    const history = createDownloadHistory({ storage: memoryStorage() });
    await reconcileHistory(history, { statusDir: dir });

    const [row] = await history.list();
    assert.equal(row.status, "failed");
    assert.equal(row.error.code, "http_server");
    assert.equal(row.error.message, "500");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcileHistory leaves an in-flight download alone", async () => {
  // Folding a running download into history would report it as finished.
  const dir = mkdtempSync(join(tmpdir(), "recon-live-"));
  try {
    writeStatus(statusFixture({ id: "live", state: "downloading", finishedAt: undefined }), dir);
    const history = createDownloadHistory({ storage: memoryStorage() });

    assert.equal(await reconcileHistory(history, { statusDir: dir }), 0);
    assert.equal((await history.list()).length, 0);
    assert.ok(readStatus("live", dir), "an in-flight status must survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcileHistory maps meta through the consumer's projection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recon-meta-"));
  try {
    writeStatus(statusFixture({ meta: { recordingId: "123" } }), dir);
    const history = createDownloadHistory({ storage: memoryStorage() });

    await reconcileHistory(history, { statusDir: dir, toMeta: (s) => ({ recordingId: s.meta?.recordingId }) });
    const [row] = await history.list();
    assert.equal(row.meta.recordingId, "123");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcileHistory folds several downloads in one pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recon-many-"));
  try {
    writeStatus(statusFixture({ id: "a" }), dir);
    writeStatus(statusFixture({ id: "b", state: "cancelled" }), dir);
    writeStatus(statusFixture({ id: "c", state: "downloading", finishedAt: undefined }), dir);

    const history = createDownloadHistory({ storage: memoryStorage() });
    assert.equal(await reconcileHistory(history, { statusDir: dir }), 2, "only the terminal ones");
    assert.equal(listStatuses(dir).length, 1, "the live one stays");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clear() cannot be undone by an add() that was already in flight", async () => {
  // clear() was the one mutation outside the lock. An add() partway through its
  // read-modify-write would write its snapshot back afterwards, resurrecting
  // rows the user just cleared.
  const history = createDownloadHistory({ storage: memoryStorage() });
  await history.add({ id: "1", filename: "a", outputPath: "/tmp/a", status: "completed" });

  const adding = history.add({ id: "2", filename: "b", outputPath: "/tmp/b", status: "completed" });
  const clearing = history.clear();
  await Promise.all([adding, clearing]);

  const rows = await history.list();
  assert.ok(!rows.some((r) => r.id === "1"), "the pre-existing row must not come back");
});
