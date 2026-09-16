# @chrismessina/raycast-download

Downloads for Raycast extensions that survive the window closing.

## The problem

Raycast unloads a command when the user presses Escape or pops back to root search. From the [lifecycle docs](https://developers.raycast.com/information/lifecycle):

> Any async work you kick off should not be relied on to keep running.

An in-flight stream to disk is torn down mid-write, leaving a truncated file. `no-view` mode does not help — it runs until its promise resolves, and the promise *is* the thing doing the downloading.

So the transfer runs in a **detached child process** that outlives the command, reporting through a status file on disk rather than through memory.

```ts
import { startDownload, watchStatus } from "@chrismessina/raycast-download";

const ticket = await startDownload({
  url: signedUrl,
  outputPath: "/Users/me/Downloads/recording.mp4",
  expectedBytes: 383713905,
});

// The user can dismiss Raycast here. The download continues.

watchStatus(ticket.id, {
  onChange: (s) => console.log(s.bytesDownloaded, "/", s.totalBytes),
  onSettled: (s) => console.log(s.state),
});
```

## Scope of the guarantee

**Survives:** Raycast dismissal, the command being unloaded, the parent process exiting.

**Does not survive** (without user action): machine sleep, power loss, unattended network drops. Partial files are always retained, so an interrupted transfer resumes via HTTP Range instead of starting over.

This is stated narrowly on purpose. Detached spawn solves parent-process-exit — the problem Raycast creates. It is not a download supervisor.

## Platforms

macOS and Windows. `curl` is used for the transfer and ships with both (Windows 10+ includes it at `System32\curl.exe`).

The supervision around the transfer differs, because the two platforms have genuinely different process models:

| | macOS / POSIX | Windows |
|---|---|---|
| Detach | `detached: true` + `unref()` | `unref()` only — `detached` there means "new console window" |
| Cancel | `process.kill(-pid)` on the process group | `taskkill /PID <pid> /T` walks the tree |
| Identity | `ps -o lstart` | PowerShell `Get-Process().StartTime`, falling back to `wmic` on older builds |
| Who records the outcome | the runner's SIGTERM handler | `killDownload`, since nothing catchable is delivered |

### When identity can't be established

Some environments can't resolve a process's start time at all. Two different questions then get two different answers, deliberately:

**"Is this download still running?"** → falls back to the runner's heartbeat. A process that hasn't written a status in 30 seconds (60 missed beats) is treated as dead. Biasing unconditionally toward "alive" would be worse than it sounds: a dead runner would never be reconciled, its partial never reaped, and a watcher would poll a stuck status forever.

**"Should I signal this pid?"** → refuses. Guessing wrong about liveness costs a mislabelled status; guessing wrong about identity kills an unrelated process tree. `killDownload` returns `false` and records a terminal status rather than signalling on an unproven pid.

`canVerifyProcessIdentity()` exposes which regime you're in.

## Two layers

**Layer A — transport** (`status`, `detach`, `curl`): for extensions downloading from a URL.

**Layer B — everything else** (`paths`, `errors`, `progress`, `history`): useful to any extension that puts a file on disk, however it got the bytes.

The split is deliberate. A tool that owns its own transport — a vendor CLI, say, which never exposes a URL, picks its own output path, and emits no progress — can consume Layer B without being forced through a URL-shaped API that does not fit it.

## Design notes

Each of these exists because the obvious implementation is wrong in a way that only shows up in production.

**Process identity is `(pid, startTime)`, never a bare pid.** macOS `kern.maxproc` is 16000, so pids get recycled. A liveness check of `kill(pid, 0)` alone answers "does *some* process have this pid" — and cancelling on that basis can `kill(-pid)` an unrelated process group.

**Credentials never touch argv.** `ps` is world-readable. Measured: a URL passed as a curl argument is visible to any process on the machine; written to a `0600` config file and passed by path as `curl -K <file>`, it is not. The config is unlinked as soon as curl's first output byte proves it has been read. Signed URLs are bearer credentials, so the config-file channel is a requirement rather than a preference.

**Timeouts are throughput-based, not wall-clock.** `--max-time` counts machine sleep against the budget, so a laptop closed for ten minutes guarantees a spurious failure on a healthy transfer. `--speed-limit`/`--speed-time` measure actual throughput and are sleep-tolerant.

**`.part` file plus atomic rename.** Cancelling a naive download leaves a truncated file that looks exactly like a successful one. Bytes land in `<outputPath>.part` and are renamed only after the size is verified.

**Status writes are atomic and polled, not watched.** `writeFileSync(tmp)` + `renameSync` means a reader never sees half-written JSON — but the rename replaces the inode, so an `fs.watch` bound to the original file silently stops firing. Hence polling.

**Liveness and throughput are separate signals.** `heartbeatAt` advances while the process lives; `lastByteAt` advances only when bytes move. Conflated, a hung-but-alive transfer reads as healthy forever.

**`finalizing` is a real state.** The runner writes `finalizing` → renames → writes `completed`. A crash between the rename and the completion write leaves a correct file on disk; reconciliation recognizes that rather than reporting a failure and prompting a needless re-download of hundreds of megabytes.

**curl's default meter, not `--progress-bar`.** The progress-bar mode emits only a percentage. The default meter carries real bytes, total, speed and ETA — verified against captured output, not assumed.

## Known limitations

Stated plainly so a consumer doesn't discover them the hard way.

**Leases are per-instance, not distributed.** `acquireLease` serializes adoption well enough for two windows of the same extension, but it is a read-then-write on a file, not a true compare-and-swap. Two processes racing within the same millisecond can both believe they won. The realistic case — a user opening a second window seconds later — is covered.

**Reusing an `id` while its download is still running starts a competing writer.** Despite "reuse it to resume", there is no active-status check. Reuse an id only after the previous transfer reached a terminal state.

**Schema evolution has no in-flight migration.** Readers reject a status whose `schema` they don't recognize. If a future version bumps it while a download from the old version is mid-flight, that transfer becomes invisible to watch/cancel/prune — it still completes, but nothing tracks it.

**Bundling.** `startDownload` resolves `runner.js` from `__dirname`. If a consumer inlines `detach.js` into a single bundle without copying `dist/runner.js` alongside, it throws "runner not found" — loudly, not silently. Keep the package external, or copy the runner into the bundle directory.

**`npm test` runs against the built `dist`** — the script builds first, so it is never stale, but invoking `node --test` directly is. The integration suite hits the real network; set `SKIP_INTEGRATION=1` to skip it.

## API

```
paths     expandHome · isContained · resolveDirectory · uniquePath · sanitizeFilename
errors    DownloadError · DownloadErrorCode · classifyHttpStatus · isDownloadError
progress  formatBytes · formatSpeed · formatEta · formatProgressLine · createThrottle
history   createDownloadHistory
status    writeStatus · readStatus · listStatuses · watchStatus · pruneStatuses
          isAlive · isStalled · isTerminal · acquireLease · releaseLease
detach    startDownload · killDownload · reconcile · runnerPath
curl      buildCurlConfig · parseCurlMeter · parseWriteOut · classifyCurlFailure
```

Import from the root or from a subpath (`@chrismessina/raycast-download/paths`).

## Notes for consumers

**Never put a signed URL in `meta`.** It is persisted to the status file. Store an identifier you can re-resolve from instead.

**Retry policy is yours.** Consumers differ too much to share one: `DownloadError.retryable` gives you the signal, the loop stays in your code.

**`uniquePath` numbering starts where you say.** Existing extensions differ (`(1)` vs `(2)`); `startAt` preserves that, because unifying it silently renames files users already have.

## Development

```bash
npm run build      # tsc
npm test           # node --test, includes live network integration tests
SKIP_INTEGRATION=1 npm test   # unit tests only
```

Zero runtime dependencies. `@raycast/api` is a peer, and is loaded lazily so the runner and the tests work outside a Raycast host.

## License

MIT
