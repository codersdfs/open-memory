# Explicit tool-first over auto-inject middleware

The agent recalls memories via an explicit `memory.search(query, {k, budgetTokens})` tool that returns `{memories, tokensUsed, truncated, summary}`. A helper `autoInject()` is available but opt-in only. Invisible middleware that prepends memories on every turn looks convenient but burns tokens unpredictably and hides context-burn; explicit calls make burn measurable and let the UI preview exact budget impact per query.
