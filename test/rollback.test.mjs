/**
 * Rolling a `.part` file back after a 3xx.
 *
 * curl writes a redirect BODY into the `.part` file. On a RESUMED transfer the
 * bytes before it are the user's real progress, so the runner rolls back to
 * `existingBytes` rather than discarding everything.
 *
 * The property under test is what happens when that rollback CANNOT be made.
 * A partial whose length we cannot vouch for must not survive: the consumer
 * resumes with `curl -C -`, which appends from the file's current size, so
 * leftover redirect HTML gets the real recording spliced onto the end of it and
 * published under the user's filename. Losing progress is recoverable; a
 * silently corrupt media file is not.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rollbackPartial } from "../dist/paths.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "rollback-"));
}

test("rolls a partial back to the byte count that was verified good", () => {
  const dir = tempDir();
  try {
    const part = join(dir, "clip.mp4.part");
    writeFileSync(part, Buffer.concat([Buffer.alloc(50, 1), Buffer.from("<html>redirect</html>")]));

    assert.equal(rollbackPartial(part, 50), true, "rollback should succeed");
    assert.equal(statSync(part).size, 50, "the redirect body must be gone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports failure AND leaves no resumable partial when the file cannot be truncated", () => {
  const dir = tempDir();
  try {
    const part = join(dir, "clip.mp4.part");
    writeFileSync(part, Buffer.concat([Buffer.alloc(50, 1), Buffer.from("<html>redirect</html>")]));
    // Read-only: truncate(2) needs write permission, so the rollback cannot land.
    chmodSync(part, 0o444);

    const ok = rollbackPartial(part, 50);
    assert.equal(ok, false, "an unverifiable rollback must report failure");

    // Whatever it did, it must not leave bytes a resume would append to.
    const survives = existsSync(part) && statSync(part).size > 50;
    assert.equal(survives, false, "a partial longer than the verified prefix must not remain resumable");
  } finally {
    try {
      chmodSync(join(dir, "clip.mp4.part"), 0o644);
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a partial that is already at or below the target is left alone", () => {
  const dir = tempDir();
  try {
    const part = join(dir, "clip.mp4.part");
    writeFileSync(part, Buffer.alloc(30, 7));
    assert.equal(rollbackPartial(part, 50), true);
    assert.equal(statSync(part).size, 30, "must not grow or destroy a shorter partial");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses an invalid keepBytes without touching the file", () => {
  const dir = tempDir();
  try {
    const part = join(dir, "clip.mp4.part");
    writeFileSync(part, Buffer.alloc(80, 1));

    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(rollbackPartial(part, bad), false, `keepBytes=${bad} must be rejected`);
      assert.equal(statSync(part).size, 80, `keepBytes=${bad} must not destroy progress`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reports unsafe when the filesystem denies every cleanup", () => {
  const dir = tempDir();
  const part = join(dir, "clip.mp4.part");
  try {
    writeFileSync(part, Buffer.concat([Buffer.alloc(50, 1), Buffer.from("<html>redirect</html>")]));
    chmodSync(part, 0o444); // truncate denied
    chmodSync(dir, 0o555); // unlink denied

    // Nothing on disk can be fixed here, so the RETURN VALUE is the whole
    // mitigation — the runner writes it into the status and the consumer
    // refuses to resume. A test asserting the file gets neutralised would be
    // asserting something the filesystem has forbidden.
    assert.equal(rollbackPartial(part, 50), false, "an uncleanable partial must report unsafe");
  } finally {
    try {
      chmodSync(dir, 0o755);
      chmodSync(part, 0o644);
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
