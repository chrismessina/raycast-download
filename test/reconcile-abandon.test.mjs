/**
 * Regressions in `reconcileHistory`'s abandoned-status handling and in the
 * url-policy guarantee on the read path.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDownloadHistory, reconcileHistory } from "../dist/history.js";
import { writeStatus } from "../dist/status.js";

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

/** Dead by construction: `startedAtMs: 1` cannot match any real process start. */
function statusFixture(overrides = {}) {
  const now = Date.now();
  return {
    schema: 1,
    id: "rec-1",
    pid: process.pid,
    startedAtMs: 1,
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

test("clearAbandoned still runs when there is nothing terminal to fold in", async () => {
  // `if (finished.length === 0) return 0` sits ABOVE the clearAbandoned loop, so
  // a directory holding only a dead in-progress attempt — the exact case
  // clearAbandoned exists for — returned early and cleared nothing.
  const dir = mkdtempSync(join(tmpdir(), "abandon-only-"));
  try {
    writeStatus(statusFixture({ id: "dead-1", state: "downloading", finishedAt: undefined }), dir);

    const history = createDownloadHistory({ storage: memoryStorage() });
    await reconcileHistory(history, { statusDir: dir, clearAbandoned: true });

    assert.ok(
      !existsSync(join(dir, "dead-1.json")),
      "an abandoned status must be cleared even when no terminal status exists",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearAbandoned does not delete an attempt that COMPLETED during the await", async () => {
  // The identity check confirms it is the same attempt, which is right for the
  // retry case — but the same attempt can also finish mid-await. It is then
  // terminal, not alive, and NOT in the `finished` snapshot, so no history row
  // was written for it. Deleting it loses the download entirely.
  const dir = mkdtempSync(join(tmpdir(), "abandon-race-"));
  try {
    writeStatus(statusFixture({ id: "done-1" }), dir);
    const inflight = statusFixture({
      id: "finisher-1",
      state: "downloading",
      finishedAt: undefined,
      bytesDownloaded: 40,
    });
    writeStatus(inflight, dir);

    const storage = memoryStorage();
    let swapped = false;
    const racing = {
      ...storage,
      async setItem(key, value) {
        if (!swapped) {
          swapped = true;
          // Same attempt (same pid + startedAt), now finished and exited.
          writeStatus(
            { ...inflight, state: "completed", bytesDownloaded: 100, finishedAt: Date.now() },
            dir,
          );
        }
        return storage.setItem(key, value);
      },
    };

    const history = createDownloadHistory({ storage: racing });
    await reconcileHistory(history, { statusDir: dir, clearAbandoned: true });

    assert.ok(
      existsSync(join(dir, "finisher-1.json")),
      "a status that went terminal during the await must survive, so the next reconcile folds it in",
    );

    // And the next pass must actually record it, rather than leaking it forever.
    await reconcileHistory(history, { statusDir: dir, clearAbandoned: true });
    const rows = await history.list();
    assert.ok(
      rows.some((r) => r.id === "finisher-1" && r.status === "completed"),
      "the completed download must reach history on the following reconcile",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list() honours urlPolicy for rows written under an earlier policy", async () => {
  // Screening only happened on the write-merge path, so a read-only session
  // handed the caller back the signed URL the policy exists to suppress.
  const storage = memoryStorage();
  const permissive = createDownloadHistory({ storage });
  await permissive.add({
    id: "legacy",
    filename: "leak.mp4",
    outputPath: "/tmp/leak.mp4",
    status: "completed",
    url: "https://bucket.s3.amazonaws.com/leak.mp4?X-Amz-Signature=deadbeef&X-Amz-Expires=900",
    timestamp: 1000,
  });

  const strict = createDownloadHistory({ storage, urlPolicy: "omit-signed" });
  const rows = await strict.list();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, undefined, "list() must not hand back a signed URL under omit-signed");
});
