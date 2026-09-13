# Batch 127 ? Speech-turn PCM tail draining

Web tap subscriptions now expose finish(): sends one exact-generation tap_finish message, delivers the short final PCM frame, then reports finished. It does not pause/flush the original five-second recording framer. The listener must wait for this ordered end before sending a translation commit. Abrupt detach still discards private pending tail; old drain/close callbacks cannot affect a replacement. Existing Web PCM behavior rounds down less than one millisecond at flush, while native tap pads to a whole millisecond.

Android d3d4d332 adds per-subscription finish with the same source-preserving lifecycle; whole-microphone finish still closes the source permanently. Authorization and overflow checks remain active during draining.

Validation: Web 26 unit scenarios, TypeScript/ESLint and production build pass; real Chromium fake-device test proves turn draining, next-turn isolation and continuing original five-second output using one microphone. Android 20 JVM + 8 isolated service tests, enabled/default Debug/test builds and token checks pass. Default flags remain off; Web/native translation clients follow. No real provider/microphone call was made.
