/**
 * A stand-in for the detached runner, for the cross-process status race.
 *
 * Writes `downloading`, takes the status lock with RAW `fs` (so the script
 * behaves identically against a build that has no lock at all — that is the
 * point: the test has to be runnable against the pre-fix code), holds it while
 * a real download would be finishing, writes `completed`, and lets go.
 *
 * Raw writes rather than `writeStatus` on purpose: `writeStatus` takes the same
 * lock, and a process cannot be its own lock's tester.
 *
 * argv: <statusDir> <id> <holdMs> <markerPath>
 */
import { closeSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, id, holdMsRaw, marker] = process.argv.slice(2);
const holdMs = Number(holdMsRaw);
const target = join(dir, `${id}.json`);

function put(state, extra = {}) {
  const now = Date.now();
  const status = {
    schema: 1,
    id,
    pid: process.pid,
    startedAtMs: now,
    state,
    filename: "a.bin",
    outputPath: join(dir, "a.bin"),
    partPath: join(dir, "a.bin.part"),
    bytesDownloaded: state === "completed" ? 100 : 50,
    totalBytes: 100,
    startedAt: now,
    heartbeatAt: now,
    ...extra,
  };
  const tmp = `${target}.${process.pid}.child.tmp`;
  writeFileSync(tmp, JSON.stringify(status), { mode: 0o600 });
  renameSync(tmp, target);
}

put("downloading");

const lockPath = `${target}.lock`;
const fd = openSync(lockPath, "wx", 0o600);
writeFileSync(marker, "ready");

Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);

put("completed", { finishedAt: Date.now() });

closeSync(fd);
unlinkSync(lockPath);
