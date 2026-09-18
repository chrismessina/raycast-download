/**
 * The path-keyed claim and the durable partial state, tested directly.
 *
 * These are the pieces whose failure modes are races and permission errors —
 * neither of which an end-to-end download test can produce on demand.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  claimPartialPath,
  claimPath,
  markPartialUnsafe,
  mayResume,
  parseValidators,
  partialClaimHolder,
  readPartialState,
  releasePartialClaim,
  resetPartial,
  resourceFingerprint,
  statePath,
  urlFingerprint,
  writePartialState,
} from "../dist/partial.js";

function tempPart() {
  const dir = mkdtempSync(join(tmpdir(), "partial-"));
  return { dir, partPath: join(dir, "f.bin.part") };
}

test("a second claim on a live path is refused", () => {
  const { dir, partPath } = tempPart();
  try {
    const first = claimPartialPath(partPath, { pid: process.pid, startedAtMs: Date.now(), id: "a" });
    assert.equal(typeof first, "string");
    assert.equal(
      claimPartialPath(partPath, { pid: process.pid, startedAtMs: Date.now(), id: "b" }),
      undefined,
      "the second caller must not also believe it owns the path",
    );
    assert.equal(partialClaimHolder(partPath)?.id, "a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a claim is released only by its holder", () => {
  const { dir, partPath } = tempPart();
  try {
    const token = claimPartialPath(partPath, { pid: process.pid, startedAtMs: Date.now(), id: "a" });

    // A late handler from an earlier, failed attempt.
    releasePartialClaim(partPath, "some-other-token");
    assert.equal(existsSync(claimPath(partPath)), true, "a stale token must not release someone else's claim");

    releasePartialClaim(partPath, token);
    assert.equal(existsSync(claimPath(partPath)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a damaged claim is NOT stolen, and force is the way out", () => {
  const { dir, partPath } = tempPart();
  try {
    // Not valid JSON: with atomic creation, this cannot be a half-written
    // claim, so it is damage rather than a race — and stealing on that basis is
    // how two runners end up appending to one file.
    writeFileSync(claimPath(partPath), "{not json");
    assert.equal(
      claimPartialPath(partPath, { pid: process.pid, startedAtMs: Date.now(), id: "a" }),
      undefined,
    );

    releasePartialClaim(partPath, undefined, true);
    assert.equal(typeof claimPartialPath(partPath, { pid: process.pid, startedAtMs: Date.now(), id: "a" }), "string");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a claim missing its start time is not honoured", () => {
  const { dir, partPath } = tempPart();
  try {
    // Without a start time the identity check would compare the running pid to
    // itself and pass tautologically, so an unrelated program that inherited
    // the pid would hold the path forever.
    writeFileSync(claimPath(partPath), JSON.stringify({ pid: process.pid, id: "ghost", token: "t" }));
    assert.equal(partialClaimHolder(partPath), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resetPartial keeps the filename reserved", () => {
  const { dir, partPath } = tempPart();
  try {
    writeFileSync(partPath, "contaminated");
    markPartialUnsafe(partPath);

    assert.equal(resetPartial(partPath), true);
    assert.equal(readFileSync(partPath, "utf8"), "", "the bytes must be gone");
    assert.equal(existsSync(partPath), true, "but the reservation on the final name must survive");
    assert.equal(existsSync(statePath(partPath)), false, "and nothing stale may be left describing it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mayResume: what is and is not enough", () => {
  const url = "https://example.com/a/file.bin?sig=NEW";
  const identity = { urlHash: urlFingerprint(url), resourceHash: resourceFingerprint(url) };

  assert.equal(mayResume(undefined, url), false, "nothing recorded");
  assert.equal(mayResume({ v: 1, ...identity }, url), false, "no validator");
  assert.equal(mayResume({ v: 1, ...identity, unsafe: true, etag: '"v1"' }, url), false, "marked unsafe");
  assert.equal(mayResume({ v: 1, ...identity, etag: '"v1"' }, url), true, "exact url + validator");
  assert.equal(
    mayResume({ v: 1, resourceHash: resourceFingerprint("https://example.com/a/file.bin?sig=OLD"), etag: '"v1"' }, url),
    true,
    "a re-signed link is the same resource",
  );
  assert.equal(
    mayResume({ v: 1, resourceHash: resourceFingerprint("https://example.com/b/other.bin"), etag: '"v1"' }, url),
    false,
    "a different path is a different resource",
  );
});

test("a malformed unsafe flag reads as unsafe", () => {
  const { dir, partPath } = tempPart();
  try {
    writeFileSync(statePath(partPath), JSON.stringify({ v: 1, unsafe: "yes", etag: '"v1"' }));
    assert.equal(readPartialState(partPath)?.unsafe, true);
    assert.equal(mayResume(readPartialState(partPath), "https://example.com/f"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseValidators takes the last block and refuses weak ETags", () => {
  const dump = [
    "HTTP/1.1 302 Found",
    'ETag: "first-hop"',
    "",
    "HTTP/1.1 200 OK",
    'ETag: "final-hop"',
    "Last-Modified: Wed, 17 Sep 2026 12:00:00 GMT",
    "",
  ].join("\r\n");
  assert.deepEqual(parseValidators(dump), { etag: '"final-hop"', lastModified: "Wed, 17 Sep 2026 12:00:00 GMT" });

  // Weak validators are forbidden in If-Range: two weak-equivalent
  // representations may differ byte for byte, which is exactly the difference a
  // resumed transfer cannot survive.
  const weak = ['HTTP/1.1 200 OK', 'ETag: W/"weak"', ""].join("\r\n");
  assert.equal(parseValidators(weak).etag, undefined);
});

test("writePartialState survives a reader catching it mid-write", () => {
  const { dir, partPath } = tempPart();
  try {
    writePartialState(partPath, { v: 1, urlHash: "a".repeat(32), etag: '"v1"' });
    // The temp file is renamed into place, so a reader sees the old state or
    // the new one, never a truncated one that would read as "nothing recorded".
    assert.equal(readPartialState(partPath)?.etag, '"v1"');
    assert.equal(existsSync(`${statePath(partPath)}.${process.pid}.tmp`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
