# Batch 138: Web recovery across remounts

Private translation now persists only the exact source-bound command metadata in tab-scoped storage. Reopening the provider offers explicit replay using the same key and body; it never dispatches or enables playback automatically. Viewer/room/connection changes remount the session. Requests have an eight-second cancellation deadline and are aborted on unmount; a late response cannot remove the retained recovery marker.

Export, summary sharing, notification retry and shared interpretation distinguish a missing recovery marker from an unreadable existing marker. Corrupt or unavailable storage blocks replacement commands and preserves the marker. Source text, questions and audio are not added to session storage.

Validation: 64 focused component scenarios, 991 tests across the complete Web suite, TypeScript, changed-file ESLint and production build pass. Cases include ambiguous start/remount/exact replay without audio, late success after unmount, and corrupt JSON/shape/empty storage. The existing production chunk-size warning remains. Agent regression also passes all 150 tests; no real model calls or external messages were made.

No migration or feature flag change. Backend acknowledgement support from batch 137 must precede the new Web deployment. Next: conclude the technical review and replace historical deployment instructions with the current handoff.
