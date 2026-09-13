# Phase 3 batch 75 (cumulative 95): native in-meeting controls

Android main `b3270475` adds exact-occurrence recording controls, explicit start/stop confirmation, encrypted unknown-request recovery and join-token-only participant notices. The notice remains visible with hidden toolbars; opening the exact record preserves the call. Reconnection closes the previous workspace.

`WE_MEET_ONLINE_AI_NATIVE=false` is a new independent Android build flag. Cloud-video recording remains its existing placeholder. No backend migration or default provider/agent flag changed.

17 isolated instrumentation tests, enabled Debug/test APK, default-disabled Debug build, design-token/diff checks and light/dark screenshot review passed. Actual connected-room layout, device reconnection and provider deployment remain user testing. Native translation alignment and remaining first-release gaps continue next.
