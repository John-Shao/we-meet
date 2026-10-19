# Negotiated fixed translation with original-only transcription

2026-10-19. For fixed `en -> zh`, English is translated/spoken in Chinese, Chinese is transcribed without reverse translation or speech synthesis, and unknown/out-of-pair speech creates no content. Transcript persistence remains the Android history opt-in; this feature adds no raw-audio retention.

## Contract

- `/api/v1.0/assistant-translation/config/` adds `fixed_transcription_languages` (the intersection of product languages and the ASR adapter's supported languages).
- Ticket requests may set `record_other_language: true` only with a valid `fixed_source` and supported opposite language. Validation runs before reserving a business session. This flag is signed into the ticket, revalidated during claim and echoed in the ticket response when true.
- WebSocket v2 `ready` echoes `record_other_language`. The new Android client requires both echoes before opening the microphone. Legacy requests default to false; their fixed routing remains unchanged and receives no new event type.
- New mode routes admitted VAD speech through the existing on-demand language detector, then to either the fixed translator or pure ASR. Unknown notices are suppressed only for this negotiated mode. Recognition transport failure still fails explicitly; it is not equivalent to unrecognized speech.
- New event: `{"type":"transcription","id":"asr:<provider-id>","source_language":"zh","source":"<final original>"}`. There is no target text, audio or audio-end event for this row.
- Only a final ASR result whose actual language matches the record-only language is emitted. Model language is not forced. An explicit third-language translation result is discarded. Late evidence of the record-only language on the translation route preserves its original while discarding all translated audio/text.

## Resource and protocol boundaries

The ASR adapter uses `qwen3-asr-flash-realtime` with PCM16/16 kHz mono, manual commit and explicit `session.finish`/`session.finished`. Router heartbeat silence is not appended to the manual buffer. Each admitted record-only turn has at most 30 seconds of audio and its own completed/closed provider session, preventing accumulated manual-session audio in a long conversation. Establishing the next utterance's connection is normal lifecycle, never a retry/replay of accepted audio. Existing ingress queue/deadline bounds continue to apply while the router waits for the final boundary.

Final text is bounded to 20,000 characters; IDs and deduplication history are bounded to 128. Results without an admitted pending turn fail closed. The actual manual endpoint returned `event_id` without `item_id`, so the adapter uses `item_id` when present and otherwise the provider's `event_id`; it never manufactures a final-result ID. Diagnostics contain fixed failure names, field types and lengths, not model text or credentials. Disconnect, cancellation and startup failure release partial sockets/readers.

No database migration, allowlist change, quota increase, transport fallback or new automatic recovery is introduced. WebSocket remains the only bilingual transport. The media path remains App -> business gateway -> model. New fixed semantics necessarily add language discrimination and record-only ASR costs/latency; they do not retain the legacy promise of bypassing LID.

## Validation and rollout

- Business API: 119 tests passed against a dedicated test database/Redis namespace, including signed capability, invalid fixed requests before reservation and legacy ticket response compatibility.
- Gateway bilingual regression: 103 passed; related translation/provider/LID regression: 83 passed. Includes three-way routing, no translated ASR output, unknown suppression, late-language correction, final-ID fallback, duplicate handling, cancellation, and three 25-second turns on independent manual sessions.
- Real-provider probes execute candidate modules in a separate process inside the current gateway pod, using synthetic fixtures and existing operator credentials without changing the serving process. Chinese yielded one original-only row and zero translated PCM bytes; English yielded translation plus audio/audio_end; silence yielded no content. A mixed Chinese-English-Chinese conversation in one gateway connection also passed, with two original-only rows, one translation and one audio-end boundary. This is not business admission or physical-phone acceptance.
- Android's corresponding UX specification is `we-meet-android/docs/reviews/bilingual-fixed-record-only-ux-2026-10-19.md`. It requires the backend capability and both negotiation echoes and offers no misleading record-only replay controls.

Deploy both the backend config/ticket implementation and the translation gateway before distributing the new App. Preserve the existing single-account gray scope and current resource/usage limits. An old App can continue using the upgraded service; the new App refuses to silently downgrade against an old/mixed service. Building or merging this change alone is not evidence of production deployment. True acoustic acceptance and billing-amount reconciliation remain separate.

References: [ASR client events](https://help.aliyun.com/en/model-studio/qwen-asr-realtime-client-events), [server events](https://help.aliyun.com/en/model-studio/qwen-asr-realtime-server-events), [manual-session duration guidance](https://help.aliyun.com/en/model-studio/real-time-speech-recognition-user-guide). The live missing-item-ID behavior is established by sanitized probe evidence, not inferred from the documentation.
