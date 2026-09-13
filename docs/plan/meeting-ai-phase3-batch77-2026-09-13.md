# Phase 3 batch 77 (cumulative 97): native translation events/audio boundary

Android main `f6a40e3a` validates private data-channel events and keeps confirmed text immutable. With the existing native online-AI flag enabled, SDK auto-subscription is replaced by ordinary-track subscriptions plus exact, short-lived translation-track grants. Reconnection revokes grants; no translation UI grants playback yet.

16 JVM tests, enabled/default-disabled Debug builds and token/diff checks passed. Actual cancellation timing, ordinary audio/video and physical-device reconnection remain deployment checks. No real meeting/provider/audio invocation. Native translation workspace follows.
