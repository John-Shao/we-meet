# Phase 3 batch 90 / cumulative batch 110

The Web recording page now offers explicit text-only recording when authenticated backend storage preflight succeeds.

- The unchecked text-only option explains temporary server audio, separate transcription/quota consent, the 30-minute retry-start window, the 24-hour access limit, and loss of unuploaded in-memory audio on leave/reload. Resuming retains the original capture preference and rechecks admission before opening the microphone.
- Text-mode capture responses must contain valid retention metadata and matching capture/record/device identities. Invalid success receipts do not replace the original persisted operation intent. Source requests reject redirects.
- A mounted controller checks expiry, closes the microphone, clears temporary buffers and blocks new capture audio; final sealing clears temporary memory. Expired recordings can use the existing explicit incomplete-finish flow. Local audio export and saved playback are unavailable for text mode.
- ASR shows distinct retry-start/access deadlines and pending/failed/complete cleanup. It cannot start a new text transcription without current valid retention state, while an uncertain historical request remains explicitly recoverable after deadline. HTTP 401/403/404/408/429/5xx retain that original intent.
- Published text stays visible after cleanup. Original and summary audio-playback actions are suppressed for text mode. Fixed the missing library-back label, duplicate consent and misleading saved-audio status during visual walkthrough.

Validation: 50 Vitest regressions covering transport admission/receipts, recording lifecycle/expiry, ASR recovery and retention validation; actual Chromium synthetic-audio UI flows for text mode and existing media mode; screenshots inspected; TypeScript, changed-file ESLint, production build and diff checks. Browser fixtures make no real provider/deployment calls. Initial browser harness import was corrected to the Vite React DOM default export.

Deployment uses batch 108's default-off text-audio switch and cleanup prerequisites; no new migration. C05 Android protocol/lifecycle/UI follow. Standalone translation, remaining first-release gaps and final technical review are still open; M3/M4 are not complete.
