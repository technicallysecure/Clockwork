# Decision 2 · ChatGPT plan inference

Use the existing provider interface for the plan route. A tool-producing completion can return an opaque, single-use continuation. The worker returns it to the same adapter with validated tool results during the same turn. This lets Responses replay its output items, including reasoning, without storing them in the transcript. Clockwork owns the conversation, dispatch, approvals, scheduler and delivery throughout.

Treat each worker as an installation with its own stable host ID. Keep grants in a dedicated credential volume. The gateway's loopback callback routes one pending authorization to the worker that initiated it. Only that worker sees the verifier, exchanges the code, validates identity and manages the resulting session.

Partition inference context by worker, provider and memory scope. Each ChatGPT registration further partitions plan context by account and workspace. Older records with mixed or unknown provenance remain accessible to local profiles. Schedules retain their approved context when the owner switches providers. [Sign-in and verification guide](chatgpt-plan.md)
