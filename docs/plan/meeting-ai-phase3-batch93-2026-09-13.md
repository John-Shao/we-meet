# Phase 3 batch 93 / cumulative batch 113

Android commit `77103709` (main) connects text-only recording to the native page and foreground service. No API or database migration.

- Authenticated storage admission exposes an unchecked text-only choice. Permission handling preserves the selection; existing captures preserve their original mode. Consent explains temporary retention, retry deadlines, separate ASR activation/quota and loss of unuploaded memory audio on service/process exit.
- Expiry stops synthetic hardware, fences pending starts, clears temporary local buffers and prevents resume. An explicit incomplete-finish dialog uses batch 112's durable seal/consent recovery protocol.
- The page shows verified temporary-audio cleanup states and deadlines above the content tabs. Failed/invalid cleanup never claims deletion. Text captures have no player or audio seek; existing general record-detail playback already checks media retention.
- New ASR attempts require a valid retention window; uncertain existing requests remain explicitly reconcilable after expiry. Text-mode interruption messaging no longer promises audio persistence.

Validation: 21 unique isolated device scenarios across foreground recording, screen, retention and ASR controls; synthetic PCM and fake API only. Corrected test-only screenshot/hidden-button expectations; final UI suites pass. Default Debug/test builds, design-token/diff checks and light/dark visual inspection pass. All native rollout flags restored to false.

Deployment, actual cleanup timing, device behavior and model quality remain user-run acceptance work. Independent-recording translation and native cloud recording remain development scope; C05's deployment acceptance and M3/M4 are not complete.
