# Phase 3 batch 91 / cumulative batch 111

Android commit `fb3c7028` (main) adds native text-audio storage admission and retention DTOs/validation, matching backend batches 107–108. No backend change or migration in this batch.

- Authenticated capability reads require a consistent explicit availability/error pair and check the current account before and after the response.
- Text-mode capture creation requires valid retention metadata with matching capture, record and device identities. Malformed receipts cannot resolve or replace the caller's original intent.
- Capture and ASR status carry separate retry-start and audio-access deadlines, cleanup state/error and verified deletion time. The native retention helper fails closed on invalid/missing metadata and uses the earlier local/server upper bound. Expired does not mean deleted.
- Existing media clients remain compatible with older backends lacking retention metadata. The native recording service and selector still use media mode until lifecycle/cache work is integrated.

Validation: 26 JVM tests, 9 isolated Android capture-recovery tests, default Debug/test builds and design-token/diff checks. No real microphone/provider/deployment calls.

Native temporary-cache handling and consent/status UI follow. C05/M3/M4 are still incomplete; standalone translation and final technical review remain open.
