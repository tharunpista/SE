# Platform atomicity evidence

Executed on Windows 11 Pro 10.0.26200, Bun 1.4.3, NTFS, 2026-10-23.
Reproduce with `bun test tests/memory/atomicity.test.ts`.

Part XX §72 requires an atomic publish step and a directory `fsync`, and §14 of
`memory-systems-engineer` requires executed evidence per platform rather than
reasoning about correctness. This document records what the platform actually
does, because two of the specification's requirements are not implementable as
written on the most common developer platform.

## 1. `rename` over an existing file

| Condition | Result |
|---|---|
| Target exists, no open handles | **Atomic replace succeeds** |
| Target exists, another handle open on it | **Fails `EPERM`** |

Windows refuses to replace a file while any handle is open on it unless that
handle was opened with `FILE_SHARE_DELETE`, which neither Node nor Bun exposes.
Every reader therefore blocks every publish for the duration of its read.

## 2. `fsync` on a directory handle

Fails with `EPERM`. Durability of a directory entry cannot be forced this way on
Windows. §72 step 5's "then `fsync` the directory" is **conditional on platform**,
not universal. On Windows the guarantee is weaker and must be stated, not assumed.

## 3. Publish under contention --- measured

Four independent reader *processes* reading continuously; one writer publishing
as fast as it can. Same-process readers are not a valid test: cooperative
scheduling hides the conflict entirely (300/300 first-try, misleadingly clean).

| Publish primitive | Commits | First try | Needed retry | Worst case | Failed |
|---|---|---|---|---|---|
| Replace `MANIFEST.json` in place | 164 | **4** | 160 | **90 attempts** | 0 |
| Create new `manifest/<gen>.json` | 763 | **763** | 0 | 0 | 0 |

Reader-side correctness for the generation scheme, same run: **5,275 reads
across 4 processes, 0 torn, 0 generation regressions, 0 `ENOENT`.**

Replace-in-place does not fail outright only because the retry cap was 100 and
the worst case was 90. That is not a margin; it is a latent outage that appears
under load, on slower disks, or with one more concurrent reader.

## 4. Consequence for the design

The commit point is **the appearance of a new generation file**, never the
replacement of an existing one:

    memory/<project_id>/manifest/000001.json   immutable once written
    memory/<project_id>/manifest/000002.json   <- publishing this IS the commit

- `rename` to a name that does not yet exist cannot hit a sharing violation, so
  publishing is contention-free by construction rather than by retry.
- A reader resolves the live state by taking the highest generation. It observes
  generation N or N+1, never a blend, so the §73 requirement that a reader never
  sees a half-applied changeset holds structurally.
- A multi-record changeset is one generation file, so "all pointers publish
  together or none do" stops being a protocol promise and becomes a single
  filesystem operation.
- Per-record `current` files are retained as a derived, human-readable mirror
  (§70's diffability requirement), never as the authority.

This supersedes §71's pointer-file authority, §72 step 6, §73's multi-pointer
publish, and §80 invariant 1. The amendments are recorded in
`docs/spec-amendments.md`.
