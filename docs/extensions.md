# Providers, profiles and tools

## Provider capability matrix

| Clockwork capability | Hosted OpenAI | LM Studio |
| --- | --- | --- |
| Inference | Stateless `POST /v1/chat/completions` over HTTPS to `api.openai.com`, with `store: false` | Stateless `POST /v1/chat/completions` to the configured trusted endpoint |
| Chat and scoped history | Supported for a Chat Completions model accepting system messages | Supported for a loaded chat model accepting system messages |
| Native function calls | Enabled for the bundled `gpt-4.1-mini` profile. Changing its model defaults calls to off | Off by default. Enable after verifying the specific model and chat template |
| Structured response formats | Unused | Unused |
| Memory, schedules, delivery, approvals | Local SQLite and application services | Same services, including with native calls disabled |
| Credentials | Per-agent API key in **Agent settings**. Personal can also use `OPENAI_API_KEY_FILE` or `OPENAI_API_KEY` | Per-agent token in **Agent settings**. Personal can also use `LM_STUDIO_API_KEY_FILE` or `LM_STUDIO_API_KEY`. Anonymous access works when the server allows it. |
| Failure | Show a sanitized failure for this provider | Show a sanitized failure for this provider |

Both providers document the Chat Completions endpoint. OpenAI lists function calling for GPT‑4.1 mini. LM Studio documents variation in tool support among models and templates. Clockwork sends tools only when the selected profile enables native calls. It executes validated native requests through the registry. Prose, including JSON-looking prose, stays in the conversation. [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) · [GPT‑4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini) · [LM Studio compatibility](https://lmstudio.ai/docs/developer/openai-compat) · [LM Studio tool use](https://lmstudio.ai/docs/developer/openai-compat/tools)

## Configure a profile

Open an agent's **Agent settings** to change its name, goal, selected inference profile, model ID, base URL, native tool support or credential. Saving makes that profile active. The next turn uses the new goal and model settings. These changes persist across restarts in that agent's own database.

The operator defines profile IDs, instructions, providers, memory scopes and tool policy in `config/profiles/*.json` and `config/policy.json`. The following deployment variables supply initial values for the bundled profiles. Saved per-agent model settings take precedence within a profile. The deployment's local-only switch governs every worker.

| Setting | Default |
| --- | --- |
| `CLOCKWORK_LOCAL_ONLY` | `true`. Only LM Studio profiles load. Networked tools are disabled. |
| `CLOCKWORK_DEFAULT_PROFILE` | `local`, used when there is no available saved selection |
| `CLOCKWORK_LM_BASE_URL` | `http://host.docker.internal:1234/v1` |
| `CLOCKWORK_LM_MODEL` | `local-model`, a placeholder. Set this to the identifier served by LM Studio. |
| `CLOCKWORK_LM_TOOLS` | `false` |
| `CLOCKWORK_OPENAI_MODEL` | `gpt-4.1-mini` |
| `CLOCKWORK_OPENAI_TOOLS` | Enabled for the default model. Set explicitly after checking a replacement model. |

Each web-entered credential is bound to its agent, provider and destination origin (scheme, hostname and port). Select **Set a new credential** to update it or **Clear credential for this endpoint** to remove it. **Use credential for this endpoint** reuses a credential previously configured for that destination. On the personal worker, a matching startup-configured origin may use its mounted provider secret until explicitly cleared or replaced. Other workers receive independent credentials through their own settings. Among deployment settings, the secret file takes precedence over the inline environment variable.

The model adapter sends the credential in the Authorization header. The settings API reports whether one is configured. Web-entered credentials use AES-256-GCM encryption in the worker's database. Its encryption key resides beside the database, normally at `/data/clockwork.sqlite.key`. Keep this key with the private data-volume backup to restore credentials. [Agent storage and backups](agents.md)

The LM Studio adapter accepts `localhost`, `host.docker.internal`, loopback addresses, RFC 1918 IPv4 addresses, and IPv6 unique-local addresses. Hostname resolution is checked at the socket connection. The adapter follows zero redirects and makes a direct connection. For a server on another machine, set its trusted private IP and protect the link with your private network or HTTPS.

Within each agent, the two general profiles share its `personal` history and memory scope. Each worker has a separate database, so the same scope name on two workers identifies different records. With local-only mode disabled, selecting the hosted profile and sending a chat turn sends recent conversation and saved context from that worker's scope to OpenAI. The sample Focus planner has its own `focus` scope within each worker.

## Try the installed extension

1. Select the **Focus planner** profile. It requests `estimate_blocks`, implemented in `extensions/estimate-blocks.mjs`.
2. Open **Follow-ups** and create a one-time check. Choose `estimate_blocks` as the allowed tool, enter `{"minutes":80,"blockMinutes":25}` as its arguments and select **After each successful run**.
3. At the due time, its result contains `{"blocks":3,"remainingMinutes":5}`. The read works with a chat-only model or an offline inference server. With verified native calling enabled, you can also ask the Focus planner how many 25-minute blocks fit in 80 minutes.

## Add a specialty or capability

1. Copy `config/profiles/focus.json` to a new JSON file. Give it a unique ID, instructions and scope, then name the tools it requests.
2. As the operator, add a matching grant to `config/policy.json`. Set the scope, tool allowlist, and allowed permissions. The runtime checks the intersection with the profile and any narrower job allowlist on each dispatch.
3. To add a tool, export one descriptor from a new `.mjs` file in `extensions/`. Add its filename to the policy's `extensions` list and grant the desired profiles its name and declared permissions. The focus example shows all required read-tool fields.
4. Restart Clockwork to load the changes. With Docker Compose, profile and extension directories are read-only mounts in the container. Use `docker compose up -d` to apply changes to Compose environment settings.

### Tool contract

- `name`, `description`, `inputSchema`, `effect`, `permissions`, `network`, and `execute(args, {scope, signal})` are required. Execution may return a promise and must return a JSON value. Honor the abort signal during bounded reads. Install trusted code only. In-process extensions have the privileges of the application process.
- `inputSchema` uses an object root, explicit `properties`, optional `required`, and `additionalProperties: false` on every object. The validator supports nested objects, arrays with `items` and optional item-count bounds, finite numbers and safe integers with inclusive bounds, strings with length bounds, booleans, descriptions and scalar enums. Registration rejects unsupported keywords. Validation rejects undeclared properties, type coercion and oversized inputs.
- The supported effects are `read`, `external_write`, and `send`. The last two require `destination(args)` returning the actual destination for the displayed operation. Set `version` to a new value if the action semantics change. Both effects require a fresh owner decision in v1. A future MCP adapter uses the same descriptors, sets its network flag, and dispatches through the registry.
- For an external effect the registry persists the exact arguments, destination, tool, version, effect, profile and scope. Approval rechecks current permissions and destination, then claims the stored operation once. The executor receives the approved destination in its context and must use that exact value for routing. An execution error records `uncertain`. A crash during execution can leave `executing`. In either case, inspect the destination before making another proposal. There is no automated replay across that external boundary.
- A trusted chat channel authenticates the owner, identifies the selected agent and displays the provider and model from `runtime.active()`. Check the expected agent ID, profile and settings revision before calling `await runtime.chat(text)` for the saved reply. Tool results enter the model context as data. Owner decisions enter through the authenticated approval service using only the proposal ID and decision.

The shipped tests exercise the focus extension and a test-only recording action. Run `node --test test/providers.test.mjs test/capabilities.test.mjs` from the project root.
