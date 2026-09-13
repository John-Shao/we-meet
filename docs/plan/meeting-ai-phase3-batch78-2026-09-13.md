# Phase 3 batch 78 (cumulative 98): native private translation session

Android main `7dadce06` adds transient exact-connection translation state, dispatch-based freshness, explicit sound consent and ordered manual speech commands. Duplicated completion events cannot unlock later speech; unknown commands block further speech in the affected runtime until that run is stopped. Read failure/source changes clear playback.

24 JVM tests, default Debug and token/diff checks passed. No real meeting/provider/audio use. Native workspace and SDK transport integration follow; the state logic itself does not open an entry point or request microphone access.
