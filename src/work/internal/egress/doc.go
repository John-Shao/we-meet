// Package egress implements the trusted model egress send path: exactly one
// upstream model request per consumed dispatch gate, and a confirmed provider
// success that is never reclassified as unknown by a later internal failure.
//
// Authority: docs/plan/work-r0a-runtime-egress-design-2026-10-25.md §7
// (模型出口网关, §7.1 request binding and §7.2 provider call rules) and §8.1
// (F0-R3 canonical state, request and trusted receipt), with the send boundary
// and ACK-loss rules of
// docs/plan/work-r0a-data-design-2026-10-25.md §5.4 ("发送边界与 ACK 丢失").
//
// # Decision table
//
//	consume decision        provider call   terminal receipt                 result
//	won                     exactly one     succeeded (answer + usage)       succeeded
//	won + provable 4xx      exactly one     rejected_not_executed            rejected
//	rejection (no tokens)                   (zero usage, evidence, no body)
//	won + 429/5xx/timeout/  exactly one     none, attach nothing             unknown
//	network/truncated/
//	partial/redirect/auth
//	won + internal failure  no re-call      succeeded receipt (attach may be  succeeded
//	after success                           pending) or none when the answer
//	                                        itself cannot be stored
//	observed / sealed_      none            none                             not_sent
//	not_sent / consumed /
//	receipt_recorded / any
//	non-won state
//	hash mismatch, invalid  none            none                             not_sent
//	request, consume error
//	won without a receipt   none            none                             unknown
//	slot (protocol breach)                                                   (gate is
//	                                                                          consumed)
//
// "Unknown" is a reconciliation signal, not a receipt: Execute attaches
// nothing and never retries. §8.1: "终态回执只接受完整成功或供应商明确拒绝且可
// 证明未执行；429/5xx/断流、部分回答、unknown/SDK aborted 不能伪装成
// rejected_not_executed."
//
// # Write order on success
//
// §8.1 "可信回执的持久性与迟到处理": public answer put-if-absent → receipt
// put-if-absent into the preallocated slot → Gate.Attach. Execute performs
// exactly that order. Each write is read back and compared with the hashed
// bytes before the next step, so a store that returns a different object, a
// different hash form or a truncated body fails before any receipt is attached.
// The stores in this repository are create-only (fresh object id per write); a
// future mutable-slot store must enforce create-only writes itself.
// A receipt attach failure keeps the confirmed success: ExchangeResult.Outcome
// stays succeeded and the returned error carries the receipt reference and
// hash for a retry of the attach only. The provider is never called again.
//
// # Provider transport
//
// Execute makes the single provider call through the Provider interface.
// HTTPProvider is the reference openai-compatible transport: its http.Client
// refuses redirects (CheckRedirect returns http.ErrUseLastResponse), disables
// environment proxies in the default transport and has no automatic retry.
// Any SDK, proxy or transport retry must stay off as well: §5.4 item 3 permits
// at most one upstream request per won gate ("关闭 HTTP SDK/代理/流重连自动重试").
// The caller's context deadline is the only deadline; Execute adds none.
//
// # Deliberately out of scope here
//
// The package speaks to abstractions, not to the deployed processes:
//
//   - mTLS to work-control-internal:8443 and the workload certificate that
//     authenticates the gateway (GateClient adapter, §6.3/§6.5).
//   - Per-organization credential resolution (D-08b, §7.5): HTTPProvider takes
//     a Credential hook and never logs the key.
//   - The Content Store reference registry that maps the preallocated
//     AnswerRefID / RejectionEvidenceRefID uuids to the stored objects. Execute
//     writes the object and returns the content locator; the registry owner must
//     record the mapping (kind, object version, writer).
//   - Source-label checks, secret scanning, quota and price_version bookkeeping
//     (§7.2-§7.4) happen before Execute, in the egress request validation path.
//   - Provider-specific usage normalisation: HTTPProvider reads the
//     openai-compatible fields only. A provider that omits cached tokens yields
//     source=unavailable (all counts null), never a fabricated zero.
//
// The package has no PostgreSQL, Temporal or filesystem dependency; those
// boundaries stay in internal/authz, internal/content and the control plane.
package egress
