/**
 * History url-policy and reconciliation-identity regressions.
 *
 * Kept out of `history.test.mjs` so the original suite stays a record of the
 * behaviour it was written for.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDownloadHistory, reconcileHistory } from "../dist/history.js";
import { processStartTimeMs, writeStatus } from "../dist/status.js";

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

test("addMany keeps the NEWEST duplicate when the caller supplies timestamps", async () => {
  // `upsert` collapses duplicate ids within a batch keeping the FIRST, on the
  // premise that `addMany` stamps records newest-first. That premise only holds
  // when the caller OMITS timestamps — a caller that supplies them decides the
  // order, and the older row was winning.
  const history = createDownloadHistory({ storage: memoryStorage() });

  await history.addMany([
    { id: "x", filename: "older.mp4", outputPath: "/tmp/x", status: "completed", timestamp: 1000 },
    { id: "x", filename: "newer.mp4", outputPath: "/tmp/x", status: "completed", timestamp: 2000 },
  ]);

  const rows = await history.list();
  assert.equal(rows.length, 1, "one id, one row");
  assert.equal(rows[0].filename, "newer.mp4", "the newer of two same-id records must win");
  assert.equal(rows[0].timestamp, 2000);
});

test("omit-signed scrubs a signed URL already stored under an earlier policy", async () => {
  // The opted-in posture is "signed URLs stay out of persisted history". Only
  // INCOMING records were screened, so a row written while the policy was
  // "allow" was copied through and re-serialized on every later write.
  const storage = memoryStorage();

  const permissive = createDownloadHistory({ storage });
  await permissive.add({
    id: "old",
    filename: "leak.mp4",
    outputPath: "/tmp/leak.mp4",
    status: "completed",
    url: "https://bucket.s3.amazonaws.com/leak.mp4?X-Amz-Signature=deadbeef&X-Amz-Expires=900",
    timestamp: 1000,
  });

  const strict = createDownloadHistory({ storage, urlPolicy: "omit-signed" });
  await strict.add({
    id: "unrelated",
    filename: "fine.mp4",
    outputPath: "/tmp/fine.mp4",
    status: "completed",
    timestamp: 2000,
  });

  const rows = await strict.list();
  const old = rows.find((r) => r.id === "old");
  assert.ok(old, "the pre-existing row is still there");
  assert.equal(old.url, undefined, "its signed URL must not survive a write under omit-signed");
  assert.ok(
    !JSON.stringify([...storage._raw.values()]).includes("X-Amz-Signature"),
    "and it must be gone from the serialized storage, not just the returned rows",
  );
});

test("clearAbandoned does not delete a retry that claimed the id during the await", async () => {
  // `clearAbandoned` decided liveness from the snapshot taken BEFORE
  // `await history.addMany(...)` and deleted without the status lock. The await
  // is long enough for the user to press Retry, which reuses the id and writes
  // a fresh live status — and that live status file was the thing deleted.
  const dir = mkdtempSync(join(tmpdir(), "abandon-"));
  try {
    writeStatus(statusFixture({ id: "done-1" }), dir);
    // Genuinely dead: `startedAtMs: 1` cannot match this pid's real start time,
    // so `isAlive` fails the identity check. (Using `Date.now()` here would
    // MATCH the test runner's own start time within the 2s tolerance and the
    // status would read as alive — which is what a first draft of this test got
    // wrong.)
    writeStatus(
      statusFixture({ id: "reused-1", state: "downloading", finishedAt: undefined, startedAtMs: 1 }),
      dir,
    );

    const ownStart = processStartTimeMs(process.pid);
    assert.ok(ownStart !== undefined, "this platform must resolve its own start time for this test");

    const storage = memoryStorage();
    let swapped = false;
    const racingStorage = {
      ...storage,
      async setItem(key, value) {
        if (!swapped) {
          swapped = true;
          // The Retry: same id, a genuinely live identity.
          writeStatus(
            statusFixture({
              id: "reused-1",
              state: "downloading",
              finishedAt: undefined,
              pid: process.pid,
              startedAtMs: ownStart,
              startedAt: Date.now(),
              heartbeatAt: Date.now(),
            }),
            dir,
          );
        }
        return storage.setItem(key, value);
      },
    };

    const history = createDownloadHistory({ storage: racingStorage });
    await reconcileHistory(history, { statusDir: dir, clearAbandoned: true });

    assert.ok(
      existsSync(join(dir, "reused-1.json")),
      "the live retry's status file must survive clearAbandoned",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
