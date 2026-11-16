# Live coach architecture

```text
landing/chat browser -> bounded HTTP request/history -> coach context + provider adapter
 -> configured external/local model -> short coaching response
usage events -> server log / optionally configured analytics (separate from coaching)
```

[server.mjs](live-demo/server.mjs) serves allowlisted public assets and chat APIs with security headers, input/history/rate/concurrency limits, error handling and usage events. [context.mjs](live-demo/lib/context.mjs) reads ten public coach/reference files in order, rejects certain nonpublic paths and truncates assembled instructions at its limit. [llm-client.mjs](live-demo/lib/llm-client.mjs) selects Responses, compatible/home or Z.AI configuration and constructs provider calls; model names/defaults and credential requirements are provider-specific.

The browser is a chat experience around the same public method, not the implementation of account/calendar/inbox automation. Deploy compose/Docker assets are packaging, not proof the current hosted endpoint runs these exact bytes. README describes optional server/browser PostHog configuration; keys are deployment inputs and not supplied by source.

## Risks / failures

- Stuck points can contain sensitive personal/health/account information. Configured provider requests and usage instrumentation create privacy/retention boundaries; “anonymous events” is not a blanket no-data guarantee.
- Model availability, timeouts, empty/malformed replies and context truncation can break the coaching contract even when the UI loads. Bounded history may lose earlier task context. No model-quality/clinical claim follows from a context test.
- Rate/concurrency/body limits mitigate abuse, not prove production security. Remote provider spend, microphone access and account actions need separate consent; no fallback is authority to silently spend.
- Static examples/judging artifacts and live provider receipts are different evidence. Publication/deploy scripts can stage or ship content; do not run them merely to make docs verification green.

## Docs proof

Purpose/rules and actual server/context/provider source inspected. One real context test and syntax checks passed; static chat shell screenshot/API blocked. No provider/model/chat submission, analytics/mic/user account, deploy or publication. Independent user-side live/coach acceptance remains open. Runtime unchanged; revert docs for rollback.
