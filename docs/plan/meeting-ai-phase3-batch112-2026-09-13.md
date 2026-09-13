# Batch 132: Android recording translation WebSocket

Android 211834a1 adds bounded, exact-source WebSocket input on the existing microphone, ordered manual tails, bidirectional/continuous translation and transient text/audio events. The credential-free OkHttp client never reconnects or replays input. Source loss and invalid traffic close only translation.

Both Web and Android now deduplicate completed responses by direction and response ID, preventing a delayed duplicate from unlocking a later manual turn.

Validation: Android 12 socket scenarios + 1 real OkHttp/RFC6455 loopback + 9 PCM tap scenarios pass; Debug build and token checks pass. Web 13 transport scenarios, TypeScript and targeted lint pass. No real provider, physical microphone or deployment was exercised. Native playback/UI, deployment wiring and final review remain; flags stay off.
