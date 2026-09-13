# Phase 3 batch 81 (cumulative 101): native shared-interpretation listening state

Android main `fe4241fd` adds channel/subscription-bound events and explicit foreground listening. Exact source/agent/track grants are bounded by both API freshness and listener leases. Old renewal replies cannot replace a newer choice; expired selections do not auto-resume. Confirmed text stays separate from originals and is bounded/redacted locally.

25 JVM tests, default Debug and token/diff checks passed. No migration or real provider/audio/deployment invocation. Native shared SDK transport, channel management and listener UI follow.
