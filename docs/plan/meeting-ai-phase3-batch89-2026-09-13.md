# Phase 3 batch 89 / cumulative batch 109

Web recording storage now supports text-only source audio without writing its bytes to IndexedDB. The recording-page selector is the next batch.

- `CaptureJournal.create` accepts an explicit immutable creation preference, defaulting to existing media retention. Text-mode chunk checksums, sequence/timing and delivery receipts persist, but raw WAV bytes stay in a bounded per-journal memory map (existing 32 MiB pending limit).
- Upload acknowledgement clears the managed audio buffer and retains the delivery receipt. Journal close/version change clears all temporary buffers. Recovery records missing unacknowledged audio as interrupted/closed with its original sequence identities; it cannot pretend those bytes were saved or reconstruct them after leaving the page.
- Text-mode chunk access checks a local 24-hour upper bound and the server retention metadata; expiry/cleanup enrollment clears temporary bytes and blocks append. The UI/controller must still handle timely recording shutdown and explain the recovery tradeoff before this mode is exposed.
- Added typed retention metadata and fail-closed validation: hard deadline and retry-start deadline remain distinct, verified deletion requires a completion timestamp, and invalid/missing metadata cannot authorize text audio.
- Existing media-mode persistent audio recovery remains unchanged.

Validation: 21 Vitest regressions; real Chromium checks covering nine text-memory/IndexedDB invariants plus existing journal recovery, account isolation, tab locking and synthetic AudioWorklet PCM; TypeScript, changed-file ESLint, production build and diff checks. No live microphone/provider/backend was used. Initial undefined-input validator test accidentally applied its fixture default; corrected the fixture and all 21 tests passed.

No new flags or migrations. C05 selector/consent, controller cleanup and status presentation follow; Android and remaining first-release work are still open.
