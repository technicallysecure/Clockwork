# Clockwork

Clockwork is a single-owner workspace for personal agents on Core‑2. Give each agent a goal, configure its model, and assign work to one or several agents from the web interface. Each agent has its own Docker worker, private workspace files, and SQLite database for conversations, memory, follow-ups, approvals and notifications. Closing the browser leaves each worker's scheduler running.

Read the [agent isolation and deployment guide](docs/agents.md), [provider capability matrix and extension guide](docs/extensions.md), and [scheduler and recovery guide](docs/scheduler.md). The [original architecture decision](docs/0001-runtime.md) describes the application-owned runtime used inside every worker.

## Start on Core‑2

Use Docker Desktop in Linux container mode with the WSL2 engine enabled. Run these commands in PowerShell from this directory for a new installation or an upgrade. Setup preserves existing values and generates missing per-worker credentials. The personal agent keeps the original database volume. [Docker Desktop WSL2 setup](https://docs.docker.com/desktop/features/wsl/)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
docker compose up -d --build --wait
Get-Content -Raw .\.secrets\owner_password
```

Open [Clockwork on Core‑2](http://127.0.0.1:8787) and sign in with that password. The app starts in **local-only mode**. You can save memory, approve schedules and inspect runs immediately. For conversational replies, configure one of the providers below. Keep Core‑2 awake and Docker Desktop running for timely follow-ups. Set Docker Desktop to start at sign-in if you want it to resume automatically after a Windows reboot.

## Work with multiple agents

1. Open **Agents**, choose **Create agent**, and enter its name and goal. Compose starts with a personal agent and two available worker slots. An operator can add more slots on the host. [Provisioning and backup](docs/agents.md)
2. Open the agent and select **Agent settings**. Choose an inference profile, set its model ID and API base URL, and save. You can also change its goal, enable verified native tool support, and replace or clear the credential for the selected destination. The next turn uses the saved settings. Each browser tab keeps its own selected agent.
3. Use **Workspace files** to create or edit a UTF-8 text file of up to 32 KiB. The local read tools `list_workspace` and `read_workspace` expose only the selected worker's files. A profile can use these tools in an approved follow-up even when its model is offline.
4. In **Agents**, enter an assignment, select its recipients, and review their active providers before sending. The gateway dispatches the owner-entered text concurrently. Each worker uses its own goal, history, memory and permissions for the reply. Review individual outcomes in the directory and open each agent's conversation for its answer. Model output cannot dispatch work to other agents.

### Connect LM Studio

1. On the machine running LM Studio, load a chat model and start the server in the Developer tab. In Clockwork's **Agent settings**, select **General · Local** and replace the initial `local-model` placeholder with the identifier reported by `GET /v1/models`. [LM Studio server](https://lmstudio.ai/docs/developer/core/server) · [Model identifiers](https://lmstudio.ai/docs/developer/openai-compat/models)
2. For LM Studio on Core‑2, use `http://host.docker.internal:1234/v1` as the API base URL. For a separate inference machine, enter its trusted private IP, for example `http://192.168.1.50:1234/v1`. [Docker Desktop host connectivity](https://docs.docker.com/desktop/features/networking/networking-how-tos/)
3. If the worker cannot reach the server, check LM Studio's listening interface and the model host's firewall. If you enable **Serve on Local Network**, limit inbound access to Core‑2 or Docker Desktop's private network and enable token authentication. Use a protected private link or HTTPS for traffic between machines. Enter the token in the agent's credential field. [LM Studio server settings](https://lmstudio.ai/docs/developer/core/server) · [API token configuration](https://lmstudio.ai/docs/developer/core/authentication)
4. Save the settings and send a chat message. Leave native tool calling disabled for a model with unreliable calls. The UI displays the active provider and model.

To check the deployment's default endpoint from the personal worker, use the command below. HTTP 200 means the endpoint answered. HTTP 401 means it is reachable and requires a token. Substitute your saved URL if you changed it in the web interface.

```powershell
docker compose exec clockwork node -e "fetch(process.env.CLOCKWORK_LM_BASE_URL+'/models',{redirect:'error',signal:AbortSignal.timeout(5000)}).then(r=>console.log(r.status)).catch(e=>{console.error(e.message);process.exit(1)})"
```

### Enable hosted inference

The deployment's local-only setting is an operator control. To permit hosted profiles, set `CLOCKWORK_LOCAL_ONLY=false` in `.env` and run `docker compose up -d --wait`. In the chosen agent's **Agent settings**, select **General · Hosted**, enter the model ID and an OpenAI credential, and confirm. The next chat includes recent conversation and saved context from that agent's active scope. Switching back to **General · Local** keeps its conversation and schedules.

The hosted adapter defaults to `gpt-4.1-mini`. A different `CLOCKWORK_OPENAI_MODEL` defaults to chat-only unless native calls are explicitly enabled for that model. In local-only mode, the runtime omits hosted profiles, rejects hosted dispatch and blocks networked tools. An inference timeout, rejected call or HTTP failure ends that request at the selected provider. The app loads its own browser assets locally. [Provider capabilities and credential handling](docs/extensions.md)

### Secrets and private access

The gateway holds the owner password and one routing token per worker. Web-entered provider credentials are write-only and encrypted in each worker's database with a key on its private data volume. The personal worker can also use its original provider secret files. Additional workers start without provider credentials. Keep the project and volume backups private. Rotating the owner password and recreating the gateway ends existing sessions. Browser sessions also expire after 24 hours or on gateway restart.

The default published address is `127.0.0.1:8787`. Clockwork does not publish an inference port. For another device, use an existing private SSH connection to Core‑2 and open the local end of the tunnel. Example from the client, replacing the username and private hostname:

```text
ssh -N -L 127.0.0.1:8877:127.0.0.1:8787 your-user@core-2-private-name
```

Visit [Clockwork through the tunnel](http://127.0.0.1:8877). Keep SSH restricted to your private network or VPN. If you operate a private HTTPS reverse proxy instead, preserve the original Host header and set `CLOCKWORK_SECURE_COOKIE=true`. No router port forwarding is needed for Clockwork or LM Studio.

## Inside each agent

- **Conversation** stores each turn and shows provider failures. Send `/remember Use metric units` or `/commit Review the meeting notes` to explicitly save an entry, even offline. Ordinary model replies can suggest a preference or commitment. Saving it requires owner input.
- **Memory** lets you add, edit and remove preferences and mark commitments complete or open. Memory and conversation use the profile's scope. Editing memory affects the context supplied on future turns. The transcript retains what was said. The model receives bounded recent context, while you can page through the full transcript.
- **Follow-ups** lets you approve a one-time, daily or weekly reminder or tool check. Choose its first local time, IANA timezone, read tool and arguments, execution budget, and notification condition. A reminder uses its goal as the notification body. A tool check executes its approved read. Pause, resume or cancel jobs here.
- **Inbox** contains in-app deliveries and approvals. A proposed external action displays its tool, destination and full arguments. The owner approves or rejects that stored operation. Every external effect requires fresh approval in v1. The installed tools only read data or calculate a result.

For a restart demonstration, save an open commitment, schedule `list_commitments` with `{}` and **Only when the tool finds items**, then restart the service before the due time. One inbox entry appears for the matching run. Once you complete the commitment, an identical check records a quiet run. The process-level test automates both outcomes and recovery from abrupt termination. [Detailed scheduling semantics](docs/scheduler.md)

The **Focus planner** sample demonstrates an independently installed specialty. Its read tool divides a time allowance into blocks. With 80 minutes and 25-minute blocks, a scheduled check returns three blocks and five minutes remaining. Its profile, implementation and operator grant are separate files. [Sample profile](config/profiles/focus.json) · [Sample tool](extensions/estimate-blocks.mjs) · [Grants](config/policy.json)

## Operate and test

`docker compose ps` shows the gateway and each worker's health. Use `docker compose logs --tail 30 gateway` for gateway diagnostics and the worker service name for agent diagnostics. Health checks run independently of model availability. Rebuild after changing application code. Restart workers after changing operator profile files, policy or installed extensions. Web settings take effect on save.

Each agent has a persistent `/data` volume for SQLite and its credential-encryption key, and a separate `/workspace` volume for files. For a consistent backup, stop the chosen worker and copy both directories, including hidden files. The personal agent continues to use the original `clockwork_data` database volume. [Per-agent backup instructions](docs/agents.md)

Run the tests with Node 24 from the project root, or inside the Compose image. No package installation, model download, API key or live model is needed for the suite.

```powershell
node --test
# Docker-only alternative after building the image
docker compose run --rm --no-deps -v ./test:/app/test:ro clockwork node --test
```

The tests exercise multiple authenticated workers through the gateway, simultaneous assignments with distinct goals, isolated workspaces and settings, stale configuration changes and credential routing. They also cover both inference adapters, approvals, scheduler deadlines and recovery across process termination. Hosted responses are simulated. LM Studio protocol tests use a loopback HTTP fixture.

For development without Docker, use Node 24, set `CLOCKWORK_PASSWORD_FILE` to the generated password file and `CLOCKWORK_LM_BASE_URL` to the model server's host-reachable address, then run `node src/server.mjs`. This entry point reads process environment variables directly. It binds to loopback and stores SQLite under `data/` by default. The Compose configuration loads `.env`.
