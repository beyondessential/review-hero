# Agent: Performance

Focus: unnecessary allocations, expensive operations inside loops, unbounded collection growth, N+1 query patterns, missing pagination or limits on queries, inefficient algorithms (e.g. quadratic where linear is possible), resource exhaustion (connection pools, file descriptors, memory), unbounded concurrency or parallelism, large payloads that should be streamed or batched.

Ignore: micro-optimisations, correctness, style, security, project-specific conventions.