# Adoption plan — raycast-fetch and raycast-ios-apps

Written 2026-07-31, after the package's first consumer (raycast-fathom) shipped.
Findings verified by reading both codebases; anything inferred is marked.

---

## raycast-fetch — both layers, deep. The flagship consumer.

Fetch is a pure URL downloader with no domain logic between "URL" and "bytes on disk",
which is exactly the package's shape.

### What it actually buys

**Dismissal survival — a new capability, not a refactor.** `src/download.ts:100` awaits
`handle.promise` inside a `no-view` command; `src/download-batch.tsx:194` does the same in a
`view` command. Both die on Escape, mid-write. Worse: the cleanup that removes the truncated
file (`discardPartialFile`, `downloader.ts:248`) runs *in the process that just got killed*, so
it never runs. **Today, pressing Escape during a Fetch download leaves a corrupt file that looks
complete.** The package fixes that structurally via `.part` + atomic rename.

Also: real progress numbers, resume (Fetch has none — every interruption restarts from zero),
and typed errors replacing string matching.

### Delete

| Delete | Replaced by |
|---|---|
| `lib/downloader.ts:45-217` `downloadFile` + `DownloadHandle` | `startDownload` + `watchStatus` + `killDownload` |
| `lib/downloader.ts:269-299` `parseCurlProgress` | `parseCurlMeter` (inside the runner) |
| `lib/downloader.ts:301-367` `describeCurlFailure` | `classifyCurlFailure` |
| `lib/downloader.ts:219-231`, `:248-267` | Obsolete — the final path is never touched until verified |
| `lib/downloader.ts:399-559` `downloadBatch` | N tickets + a scheduler (below) |
| `lib/history.ts` (108 lines) | `createDownloadHistory({ key: "download-history", limit: 100 })` — key and limit match, so existing user history survives |
| `lib/progress.ts:10-39` formatters, `:6-8,41-49` throttle map | package `progress` |
| `lib/url-utils.ts:333-364` `sanitizeFilename`, `:372-395` `generateUniqueFilename` | `sanitizeFilename`, `uniquePath({ startAt: 1, reserve: true })` |
| `lib/preferences.ts:30-33` `.replace("~", homedir())` | `resolveDirectory(..., { onUnsafe: "fallback" })` |

### Keep — do NOT absorb

- **Range patterns** (`url-utils.ts:431-607`) and URL-extraction-from-prose. Fetch's differentiators.
- **`fetchHeadInfo` / `extractFilename` / `ensureExtension` / MIME map** (`:160-320`) — naming policy, not downloading.
- **`overwriteExisting`** (`url-utils.ts:422-424`). Non-obvious: when true Fetch *deliberately*
  overwrites, so that branch must bypass `uniquePath` with a plain `join()`. See gap #5.
- All three command shells, both action panels, the history view.

### Rewrite

**`download.ts`** — the `no-view` command stops blocking. Start → watch → return; the command
may end before the download does, and that's the point.

**`download-batch.tsx:174-241`** — the spin-wait drain (`downloader.ts:507-509`) has no
equivalent because there are no promises to drain. Replacement: a `Map<itemId, DownloadTicket>`,
a scheduler starting up to `maxParallelDownloads`, and each `onSettled`/`onAbandoned`
decrementing an in-flight count and starting the next pending item. The counter is the
completion signal.

**Cancellation** — `batchHandle.cancel()` → `Promise.all(tickets.map(killDownload))`.
`cancelItem` → `killDownload(ticket)`. Both must handle `false` (already finished) without
claiming "Cancelled"; copy Fathom's handling at
`raycast-fathom`'s `src/utils/downloadRecording.ts:262-269`.

**`download-batch.tsx:466`** — the `result.error === "Download cancelled"` string match dies;
becomes `status.state === "cancelled"`. That string is produced 400 lines away at
`downloader.ts:141` with nothing linking them.

**Retry (`download-batch.tsx:314-376`) gets materially better** — reuse the same ticket id and
retry *resumes* from the retained `.part` instead of restarting.

**`resolveOutputPath`** — drop the `reserved: Set` parameter (`url-utils.ts:411-429`). It exists
only because two concurrent URLs can resolve the same name with neither on disk;
`uniquePath({ reserve: true })` solves that atomically *across processes*, which an in-memory
Set never could.

**Wire `expectedBytes`** from `fetchHeadInfo`'s `content-length` — currently parsed and never
read. **Pass `sizeCheck: "advisory"`** (see gap #6).

### Visible changes — ranked

1. **The speed accessory renders for the first time ever.** `parseCurlProgress` hard-returns
   `speed: 0` (`downloader.ts:296`) and `download-list-view.tsx:122` gates on `speed > 0`, so
   that branch has never been taken. A column of live speed values appears in a layout never
   rendered on a real screen. **Only Chris's eyes can confirm this. Put it first in testing.**
2. **The `no-view` Download command stops blocking.**
3. Progress goes from percent-only to `50% · 183 MB / 365 MB · 1.2 MB/s · 2m 30s`.
4. **Interrupted downloads leave a visible `.part` in ~/Downloads.** Correct (enables resume)
   but it's new clutter; `pruneStatuses` only reaps after 7 days. Chris's call.
5. Error wording changes; old history rows keep old strings.
6. Filename sanitization differs (`/`→`-` and stripping vs Fetch's `_`), and truncation is now
   by bytes — CJK names get shorter and stop throwing ENAMETOOLONG.
7. **`--max-time` disappears.** The user-facing "Timeout" preference (default 300s) currently
   caps total transfer time; the package uses throughput-based stalling. A 400 MB file on a slow
   link that used to fail at 5 minutes now succeeds. **Map the preference to `stallSeconds` or
   relabel it** — silently ignoring a preference the user set is the worst option.

### Order — each step independently shippable

1. **Layer B only.** History, formatters, `sanitizeFilename`/`uniquePath`, `resolveDirectory`.
   Verify the history key round-trips against real existing LocalStorage first.
2. **`download.ts` onto the transport.** Smallest transport surface.
3. **`download-batch.tsx` scheduler.** Gate on manual testing: cancel-one, cancel-all,
   retry-after-fail, batch larger than `maxParallelDownloads`.
4. **Delete `downloader.ts`.**

**Risks.** History record shape differs — Fetch's `error` is a `string` (`history.ts:11`), the
package's is `{code, message}`. `history-item-actions.tsx:44` copies it, so old rows degrade to
`[object Object]`. Tolerate both shapes or accept the loss knowingly. Also: `startDownload`
resolves only after the runner's first status write (up to 3s), so start batch items
concurrently or the list looks stalled.

**Diff: ~11 files, ≈ +250 / −950, net −700.** A day plus a manual-test pass.

---

## raycast-ios-apps — Layer B only, and narrowly. Partly churn.

**The Layer-A-impossible claim is verified on all four points**, plus a fifth:

- No fetchable URL — `ipatool.ts:824-834` spawns `ipatool download -b <bundleId>`.
- ipatool picks its own filename (`:844-847`), extension renames after (`:1405-1428`).
- Progress is `statSync`-polled every 250ms against an iTunes-API size (`:883-938`).
- Auth retry pushes a Raycast `Form` and resumes from its callback (`use-app-download.ts:179-196`).
- **`downloadApp` is recursive** (`:1065, 1095, 1132, 1193`) for corruption-retry and
  post-purchase retry. That control flow has no analogue in a detached runner.

### Take

- **`progress.ts` formatters.** `formatFileSize` is defined twice — `utils/formatting.ts:33-41`
  (which has **zero consumers**) and a local shadow at `components/app-detail-content.tsx:37`.
  Dead duplicate to delete regardless.
- **`expandHome`** — a real bug fix, see below.
- **`classifyHttpStatus` in `screenshot-downloader.ts:195-203`**, which hand-rolls the identical
  404/403/5xx ladder.

### Reject

- **`history.ts` — this is the churn case.** `use-download-history.ts` is not a history store:
  it maintains **two** keys, and the second (`DOWNLOAD_COUNTS`, `:105-131`) is a per-bundleId
  counter that survives history eviction and drives UI elsewhere. The package has no counter
  concept, and `addToHistory` already dedupes by bundleId by hand (`:140`). Wrapping this adds an
  abstraction carrying less than half the state.
- **`validateExecutablePath` (`paths.ts:102-140`) — keep unconditionally.** It validates
  `IPATOOL_PATH` against `/usr/bin`, `/opt/homebrew/bin` etc. — system roots `resolveDirectory`
  would never accept. Moving it into a download library is a category error.
- **`sanitizeFilename` (`paths.ts:145-155`) — keep.** It *throws* on empty input where the
  package returns `"download"`, and `createSafeDirectoryPath` depends on that throw.

### Rewrite

**`paths.ts:70-96` and `:170-217`** both use `absolute.startsWith(resolve(root))` — exactly the
prefix-match bug the package's `isContained` exists to prevent (`/Users-evil` passes a `/Users`
check). They're near-duplicates. Collapse to one backed by `isContained`, keeping their
`/Users`-wide policy via a custom `allowedRoots`. ~50 lines out, 5 in.

### Visible changes

1. **A real bug fix.** `paths.ts:199` does `inputPath.replace("~", homedir())` — a
   position-independent replace of the *first* `~` anywhere, so `/Users/chris/My ~Stuff` becomes
   `/Users/chris/My /Users/chrisStuff`. Rare but silently destructive. `expandHome` handles only
   a leading `~`.
2. `/Users-evil`-style paths stop being accepted.
3. File sizes render `1.5 GB` instead of `1.53 GB` — visible in the app-detail panel, one screenshot.

**Verify `IPATOOL_PATH` at `/opt/homebrew/bin/ipatool` still validates** — that's the one change
that could break the extension outright, and it's in the function I'm recommending you don't touch.

**Diff: ~5 files, ≈ +18 / −77, net −60.** An hour. Schedule as a rider on other ios-apps work,
not its own task.

---

## Package gaps found by this analysis

**#1 `reconcileHistory` — FIXED.** The runner cannot import `@raycast/api` and the command that
can is unloaded by completion, so *nothing wrote the history row*. Fathom never uses history, so
this was invisible from the reference consumer. Now: the runner leaves a terminal status file and
the next launch folds it in. Would have blocked Fetch entirely.

**#6 `sizeCheck: "advisory"` — FIXED.** The runner failed on any size mismatch. Fathom is safe
(its size comes from the API that mints the URL) but Fetch's comes from a separate `HEAD`, which
can legitimately disagree — gzip, stale `content-length`, different body per verb. Strict
checking there would reject good downloads.

### Still open

**#2 No multi-download primitive.** `watchStatus` is per-id; `listStatuses` returns everything
unfiltered. Every batch consumer will hand-roll the same counter+scheduler. Worth exporting
`watchMany(ids, {onChange, onSettled, onAllSettled})` — removes the fiddliest 40 lines of the
Fetch migration. No concurrency limiter (deliberate — that's a consumer preference), but say so
in the README.

**#3 `reconcile` may misreport a resumed download** (`detach.ts:243-245`). `totalBytes` is
written twice with different meanings across the resume path (`runner.ts:168` = existing +
Range-remaining; `runner.ts:272` = expected/final), and `reconcile`'s equality check assumes one.
INFERRED, not reproduced. Needs a test killing a resumed transfer during `finalizing`.

**#4 `resolveDirectory`'s fallback is silent** (`paths.ts:111-113`). A user whose configured
directory is rejected gets files in `~/Downloads` with no explanation. Add
`onFallback?: (attempted, chosen) => void`.

**#5 Overwrite mode forfeits reservation.** Fetch's `overwriteExisting` needs a plain `join()`,
bypassing the atomic claim. Either an `overwrite: true` option on `uniquePath` that still
reserves, or a README note.

**#7 README `startAt` note is half-wrong** — the default is already `1`, so Fetch can omit it.

---

## Unprompted finding

`screenshot-downloader.ts` (970 lines) and `icon-downloader.ts` (305) in ios-apps **do** download
from URLs — `fetch(url)` → `arrayBuffer()` → `writeFile`. So ios-apps isn't purely Layer-B; that's
true of the *IPA* path only. Still don't move them to Layer A: small images, capped at 50 MB,
buffered in memory — a detached curl per screenshot is heavier than the problem. But they are a
legitimate `classifyHttpStatus` consumer.
