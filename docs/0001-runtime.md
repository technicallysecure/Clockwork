# ADR 0001 — One owner, one durable runtime

Accepted for the first release.

Clockwork needs to keep a promise when a browser closes, an inference server fails, or Core‑2 reboots. A single Node 24 process serves the authenticated web channel and polls SQLite. SQLite owns conversation history, owner-entered memory and commitments, approved job specifications, run attempts, approval decisions, and the notification inbox. A profile change selects inference for future turns. It preserves these records.

The conversation service calls a profile-selected, stateless Chat Completions adapter. Each profile names its provider, endpoint, model, memory scope and requested tools. An operator-controlled policy limits those requests. Native function calls are opt-in per model. Chat-only models can answer in prose. The runtime never interprets prose as a tool call. Provider errors surface in the chat. Local mode restricts inference to a trusted local endpoint and denies networked tools.

An in-process registry describes schemas, permissions, network use, and effects. Every dispatch validates arguments and the effective policy. External effects require an owner decision bound to the exact stored operation. v1 ships local reads and in-app delivery. New trusted modules can register capabilities, including future MCP-backed adapters. Additional chat channels can call the same application services.

The owner explicitly saves memory or approves a schedule in the web UI. A scheduled follow-up can deliver its goal as a reminder or evaluate a read tool and a fixed condition. It needs no inference. Each occurrence has a durable identity, a bounded budget and a recoverable claim. Finalizing the run and inserting its unique inbox entry share a transaction. This keeps retries safe across process failure. Calendar recurrence uses the owner's IANA timezone.

One container, one SQLite volume and a loopback-only published port suit Docker Desktop on Core‑2. Model servers can live elsewhere. The trade-offs are a single owner, trusted installed extensions, a single-node store, and explicit forms for durable actions. v1 excludes delegation, voice and browser control.
