# Batch 131: Android recording translation protocol and recovery

Android commit 0eeb4084 adds strict capture/account/device controls, exact expiring WSS tickets, retained archive readers and encrypted metadata-only intent recovery. An unknown operation keeps its original key/body across restart. Recovery never requests a connection ticket. Credentials are excluded from intent storage and diagnostic representations.

Web receipt validation now also requires the same immutable source revision when an original result and current terminal run share an ID; a terminal replay cannot silently rebind a source.

Validation: Android 12 JVM + 5 isolated recovery scenarios, Debug/test builds and design-token checks pass. Web 8 protocol scenarios and targeted lint pass. Default flags remain off. Native transport/playback/UI, deployment wiring and full technical review follow. No real provider or physical microphone was tested.
