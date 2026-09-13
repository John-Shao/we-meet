# Batch 135: optional AI Worker deployment wiring

Helm now supports private translation, interpretation channels, standalone post-recording ASR, standalone live ASR and the capture translation gateway as five separately disabled Workers. Existing Secret references provide only the credentials needed by each process. The gateway uses a private Service and optional exact-path TLS Ingress; origins are required when enabled.

Partial releases preserve existing optional Worker image tags, while agents releases set the selected immutable tag without enabling capabilities. Failed cluster reads stop before Helm. Optional local Compose profiles cover interpretation, live ASR and capture translation; the latter stays loopback-bound and needs a TLS proxy.

Validation: eight render/script-fixture tests, Helm lint, shell syntax, Compose YAML/profile checks and diff checks passed. No cluster, real credentials or provider calls were used. Configuration, migration and rollout instructions are in [Worker deployment](meeting-ai-worker-deployment-2026-09-13.md).

Proceed to final technical review; production migration, model quality, acoustic behavior and device acceptance remain deployment tests.
