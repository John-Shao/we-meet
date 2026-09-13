# Batch 136: final review authentication fixes

Review found that Web cookie fallback and native token-refresh retries could retarget an old source-bound request to a newly logged-in account. Both clients now bind requests and refresh results to a login session. Refresh updates only the exact original credentials; login/logout change the session identifier. Late unauthorized responses cannot erase a newer native login. Native commit: `76c97d32`.

Web API and SSE share the same authenticated transport. Only GET users/me may discover a cookie identity; business operations and paid question streams cannot fall back to another actor. Buffered SSE events stop after a login change. Existing explicit authorization headers remain authoritative. Two missing pre-existing Chinese task-list audit labels found by the full suite were also repaired.

Validation: 13 focused Web authentication/SSE tests; full Web suite initially 962 passing and one label failure, followed by all three audit-label checks passing after the repair. TypeScript, ESLint and production build passed (existing large-chunk warning). Android six authentication plus eight capture-controller scenarios passed; Debug/test and design-token checks passed. These are isolated fixtures, not real login/provider acceptance.

The technical review continues with ambiguous command errors, success acknowledgements and handoff accuracy.
