# Batch 133: Android recording translation controls

Android commit `90f6e937` adds foreground/source-bound recording translation controls, encrypted exact-command recovery and bounded output-only AudioTrack playback. It shares the recording PCM tap; backgrounding, lost source/account and authorization failures close transport and playback. No automatic reconnect or replay of audio occurs.

Eight controller and five Compose scenarios passed on the isolated offline emulator. Enabled builds, restored default-off builds and design-token checks passed. Actual provider quality and physical audio routing remain deployment/device acceptance tasks.

New native flag `WE_MEET_CAPTURE_TRANSLATION_NATIVE=false`. Backend admission and gateway flags remain disabled by default. No migration. Native saved translation archives, deployment wiring and final code review follow; M3/M4 acceptance is not complete.
