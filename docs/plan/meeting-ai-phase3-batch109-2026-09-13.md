# Batch 129: Web recording translation controls and playback

The recording page now starts continuous interpretation or two-way speech translation from explicit user controls. Playback and retained text are separate opt-in choices; configuration stays frozen while a run is active. Accessible start/finish speech buttons commit one direction at a time. Ending translation keeps the original recording running.

Command metadata survives uncertain responses in account/capture-scoped tab storage. Recovery replays only the original command and never reconnects the microphone. Tickets and lease credentials remain outside intent storage. Poll results cannot overwrite a newer user operation. Backgrounding, source revision changes, recording pause and failed authorization stop the translation consumer and clear playback.

Translated PCM is copied into an output-only 24 kHz graph, bounded to three seconds and 32 nodes. Mute immediately clears queued output; unmute plays future output only. Completed/stopped audio buffers are erased. A headset hint addresses acoustic recapture; no programmatic output is fed into the recording pipeline.

Validation: 8 component scenarios and 4 playback scenarios pass; TypeScript, targeted ESLint and production build pass. Real Chromium controls with a fake microphone, isolated HTTP backend and local WS gateway verify both directions, one microphone, continued original recording and a 390 px layout. No actual provider, physical microphone or deployment test was performed.

No migrations or flag changes. Retained archive UI and Android translation integration follow; full technical review remains pending.
