# Batch 137: uncertain commands and exact acknowledgements

Review found older Web controls clearing their original request after 401/403/404/408 responses, and treating empty successful responses as completion. Human summary, task conversion, record questions, export, sharing, notification retry, private translation and interpretation now retain uncertain outcomes; only explicit 400/409/422 validation/conflict responses release them.

Successful keyed business endpoints add a command_receipt containing the accepted key and exact record/capture or room-occurrence scope. The browser checks that envelope before resolving pending intent. Existing business services retain responsibility for durable execution, permissions and matching replay payloads. Reads, previews, errors and unkeyed worker operations remain unchanged. Capture ASR also uses the acknowledgement check. No new migration.

Deploy backend before frontend. Older backends lacking the acknowledgement keep the original browser request uncertain; they do not cause automatic replacement or duplicate paid requests. Native DTOs tolerate the additive field.

Validation: 111 backend scenarios, 104 targeted Web scenarios, TypeScript, lint and production build passed. Proxy/empty/wrong-key/wrong-source acknowledgements and six uncertain HTTP classes are covered. Real provider and external delivery remain deployment acceptance. Continue pending-storage and final handoff review.
