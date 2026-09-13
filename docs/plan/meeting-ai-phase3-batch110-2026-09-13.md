# Batch 130: retained recording translation readers

The record workspace now exposes saved translation history for the exact owner-only standalone capture link. The recorder links directly to this tab. Shared transcript or summary access does not expose a standalone capture archive. Existing online translation readers remain separate.

Readers validate capture/record/run/archive/generation identities, explicit retention configuration, direction/target language, bounded pages and increasing segment sequences. Text is replaced page by page, never persisted. Backgrounding unmounts private queries; returning reauthorizes. Failed refreshes hide cached text. Partial archives show a clear incomplete-save state. Received timestamps are labeled as delivery time and never offer a fabricated audio seek.

Validation: 8 protocol, 4 archive component and 8 record-workspace scenarios pass (20 total), along with TypeScript, targeted ESLint and production build. These use isolated HTTP responses; actual permission changes and retained provider output still require deployment testing.

No backend or migration changes. Android standalone translation integration, deployment wiring and final technical review remain. Keep rollout flags off.
