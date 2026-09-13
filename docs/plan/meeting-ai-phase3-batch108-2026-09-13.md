# Batch 128: Web recording translation protocol and transport

The standalone recording client validates exact capture, account, device, generation, revision, immutable command receipts and short-lived WSS tickets. Recovery storage accepts command metadata only; it never stores tickets, lease credentials, audio or translated text. A successful HTTP status alone does not clear an intent.

The WebSocket consumer shares the recording PCM tap, bounds outstanding frames and playback input, drains manual speech turns before commit and handles empty turns explicitly. It supports forward/reverse speech translation and continuous interpretation without a second microphone, reconnect or audio replay. Source loss, invalid events and acknowledgment timeouts close only the translation consumer.

Validation: 24 Web unit scenarios, TypeScript, targeted ESLint, production build and 61 agent scenarios pass. Real Chromium with one fake microphone and a local fake WebSocket gateway verifies serialized PCM copying, consecutive control/audio sequencing, two speech directions, ordered tails and continuing original recording. The isolated page has no backend; config/directory reads are unavailable. No real microphone, provider, deployment or external notification was used.

Recording-page controls, bounded playback, archive readers and Android integration follow. Keep rollout flags disabled. No migration in this batch.
