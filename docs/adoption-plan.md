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

**#3 `reconcile` may misreport a resumed download — FIXED 2026-09-16.** `totalBytes` was written
with two different meanings across the resume path — existing bytes plus Range-remaining in one
place, the caller's expectation in another — while `reconcile`'s equality check assumed one of
them. The failing case was sharper than the original inference: with `sizeCheck: "advisory"` a
clean transfer producing fewer bytes than `expectedBytes` is deliberately publishable, but
`finalizing` recorded the *expectation*, so a crash after the rename made `reconcile` compare the
real file against a number it was never going to match and report a failure for an already-correct
file. The runner now records the size it actually publishes (`runner.ts:347` persists `finalizing`
with `totalBytes: finalBytes`), which is the value `reconcile` (`detach.ts:483`) compares against.
Covered by a test that was confirmed failing first.

> The line numbers originally cited here (`detach.ts:243-245`, `runner.ts:272`) drifted onto
> unrelated code during the fix wave — they still resolved, which is what made them dangerous.
> Verify a citation by printing the line before trusting it.

**#4 `resolveDirectory`'s fallback is silent — FIXED 2026-09-08.** A user whose configured
directory was rejected got files in `~/Downloads` with no explanation, and read it as the
preference being ignored. `onFallback?: (attempted, chosen) => void` now fires when the
resolved directory is not the one asked for. Deliberately silent in two cases: no input was
supplied (nothing was attempted, so there is no override to explain) and `onUnsafe: "throw"`
(the throw is already the signal). Four tests cover all four branches.

**#5 Overwrite mode forfeits reservation.** Fetch's `overwriteExisting` needs a plain `join()`,
bypassing the atomic claim. Either an `overwrite: true` option on `uniquePath` that still
reserves, or a README note.

**#7 README `startAt` note is incomplete** — `README.md:141` describes what `startAt` is for but
never states the default, which is already `1` (`src/paths.ts:238`), so Fetch can omit it. The note
is not wrong, just missing the one fact a caller needs to decide whether to pass the option.
Verified still open 2026-09-16.

---

## Unprompted finding

`screenshot-downloader.ts` (970 lines) and `icon-downloader.ts` (305) in ios-apps **do** download
from URLs — `fetch(url)` → `arrayBuffer()` → `writeFile`. So ios-apps isn't purely Layer-B; that's
true of the *IPA* path only. Still don't move them to Layer A: small images, capped at 50 MB,
buffered in memory — a detached curl per screenshot is heavier than the problem. But they are a
legitimate `classifyHttpStatus` consumer.

---

## Design intent — decided 2026-09-08

**The goal is a browser-grade download baseline for Raycast extensions.** Not de-duplication:
the point is that an extension that downloads something should behave the way a browser does —
survives dismissal, resumable, honest progress, a history you can act on, a path you can reveal.
That is the bar to design against when a question comes up, and it is why Layer A exists even
though no extension has it today.

**Addressable scope is the four self-authored extensions** (`fetch`, `threads`, `ios-apps`,
`brew`). Third-party monorepo downloaders — Video Downloader (`vimtor`), Instagram Media
Downloader, X/Twitter Video Downloader — are explicitly **out**: a standalone PR adding a
personal dependency to an extension Chris does not own is against house rules, and a
122k-install extension will not take one.

**`formatBytes` stays duplicated, on purpose.** It moves to `@chrismessina/raycast-kit` for
general extension use, and `progress.ts` keeps its own copy. The package advertises zero
runtime dependencies because `runner.bundle.js` must bundle standalone for the detached
process; coupling the runner to the kit for fifteen lines of arithmetic is the worse trade.

**History URL canonicalization is a per-consumer toggle, not a global normalizer.** Canonical
URLs are wanted for dedupe and counts, but a signed URL is a bearer credential. Stripping query
params is simultaneously what would make a signed URL safe to store and what would collide two
genuinely different downloads. So it is opt-in per consumer, with the security posture named at
the call site rather than assumed by the library.

**Correction (2026-09-08): the module does NOT refuse signed URLs by default.** An earlier
version of this paragraph said "the module already refuses to persist signed URLs". It did not,
and nothing in `history.ts` ever checked — `url?: string` was persisted verbatim. Keeping
credentials out of history is the CALLER's responsibility, and that is now what the JSDoc on
`DownloadRecord.url` and the header of `src/index.ts` say. For callers who want it enforced,
`createDownloadHistory({ urlPolicy: "omit-signed" })` screens each record with
`looksLikeSignedUrl()` and drops the URL; `"omit-all"` never stores one; `"throw-signed"` turns
it into a loud programming error. The default is `"allow"` — persist what you pass — because
switching an existing consumer's behaviour silently is the one thing worse than the wrong
comment.

**A "Download Manager" shim extension is rejected.** Extension A deeplinking into a Download
Manager command does not help: that command is also unloaded on dismissal, so it still needs
the detached process or a native app underneath — at which point the shim is a cross-extension
protocol and a second required install buying nothing `detach.ts` already provides directly.
The native-app version of that idea is Coaster, tracked separately. (Also: "Downloads Manager"
already exists in the Store at 76.9k installs, as a search-and-organize extension.)
