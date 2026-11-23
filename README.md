# Clockwork

Clockwork is a single-owner personal assistant for Core‑2. It keeps the conversation, explicit memory, follow-ups, action approvals and notification inbox in SQLite. Closing the browser leaves the scheduler running. The selected model supplies chat inference. A conditional check can finish while both model providers are offline.

Read the [architecture decision](docs/0001-runtime.md), [provider capability matrix and extension guide](docs/extensions.md), and [scheduler and recovery guide](docs/scheduler.md).

## Start on Core‑2

Use Docker Desktop in Linux container mode with the WSL2 engine enabled. Run these commands in PowerShell from this directory. The setup script creates a random owner password, empty provider secret files and a local configuration file. Running it again preserves existing values. [Docker Desktop WSL2 setup](https://docs.docker.com/desktop/features/wsl/)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
docker compose up -d --build --wait
Get-Content -Raw .\.secrets\owner_password
```

Open [Clockwork on Core‑2](http://127.0.0.1:8787) and sign in with that password. The app starts in **local-only mode**. You can save memory, approve schedules and inspect runs immediately. For conversational replies, configure one of the providers below. Keep Core‑2 awake and Docker Desktop running for timely follow-ups. Set Docker Desktop to start at sign-in if you want it to resume automatically after a Windows reboot.

### Connect LM Studio

1. On the machine running LM Studio, load a chat model and start the server in the Developer tab. Copy its model identifier into `CLOCKWORK_LM_MODEL` in `.env`. The initial value `local-model` is a placeholder. Use the identifier reported by the server's `GET /v1/models` endpoint. [LM Studio server](https://lmstudio.ai/docs/developer/core/server) · [Model identifiers](https://lmstudio.ai/docs/developer/openai-compat/models)
2. For LM Studio on Core‑2, keep `CLOCKWORK_LM_BASE_URL=http://host.docker.internal:1234/v1`. Docker Desktop resolves that name to the host. For a separate inference machine, enter its trusted private IP, for example `http://192.168.1.50:1234/v1`. Core‑2 only needs to run the Clockwork container. [Docker Desktop host connectivity](https://docs.docker.com/desktop/features/networking/networking-how-tos/)
3. If the container cannot reach the server, check LM Studio's listening interface and the model host's firewall. If you enable **Serve on Local Network**, limit inbound access to Core‑2 or Docker Desktop's private network and enable LM Studio token authentication. Use a protected private link or HTTPS for traffic between machines. Store the inference token as plain UTF-8 in `.secrets/lm_token`. [LM Studio server settings](https://lmstudio.ai/docs/developer/core/server) · [API token configuration](https://lmstudio.ai/docs/developer/core/authentication)
4. Run `docker compose up -d --force-recreate --wait`. Send a chat message under **General · Local**. Leave `CLOCKWORK_LM_TOOLS=false` for a model with unreliable native calls. The UI displays the active provider and model.

To check connectivity from inside the running container, use the command below. HTTP 200 means the endpoint answered. HTTP 401 means it is reachable and requires a token. A connection error points to the host, port, listening interface or firewall.

```powershell
docker compose exec clockwork node -e "fetch(process.env.CLOCKWORK_LM_BASE_URL+'/models',{redirect:'error',signal:AbortSignal.timeout(5000)}).then(r=>console.log(r.status)).catch(e=>{console.error(e.message);process.exit(1)})"
```

### Enable hosted inference

Put an OpenAI API key in `.secrets/openai_key`, set `CLOCKWORK_LOCAL_ONLY=false` in `.env`, and recreate the container with the command above. Select **General · Hosted** and confirm the provider change. Sending the next chat includes recent conversation and saved context from the shared `personal` scope. Switching back to **General · Local** preserves the conversation and schedules.

The hosted adapter defaults to `gpt-4.1-mini`. A different `CLOCKWORK_OPENAI_MODEL` defaults to chat-only unless native calls are explicitly enabled for that model. In local-only mode, the runtime omits hosted profiles, rejects hosted dispatch and blocks networked tools. An inference timeout, rejected call or HTTP failure ends that request at the selected provider. The app loads its own browser assets locally. [Provider capabilities and credential handling](docs/extensions.md)

### Secrets and private access

The owner password, LM Studio token and OpenAI key are separate files. Compose mounts each as a runtime secret. The build excludes these files, local configuration and data. Keep the project in a private Windows user directory, restrict access to `.secrets`, and enter provider keys with a local editor. Rotating the owner password and recreating the container ends existing sessions. Browser sessions also expire after 24 hours or on process restart.

The default published address is `127.0.0.1:8787`. Clockwork does not publish an inference port. For another device, use an existing private SSH connection to Core‑2 and open the local end of the tunnel. Example from the client, replacing the username and private hostname:

```text
ssh -N -L 127.0.0.1:8877:127.0.0.1:8787 your-user@core-2-private-name
```

Visit [Clockwork through the tunnel](http://127.0.0.1:8877). Keep SSH restricted to your private network or VPN. If you operate a private HTTPS reverse proxy instead, preserve the original Host header and set `CLOCKWORK_SECURE_COOKIE=true`. No router port forwarding is needed for Clockwork or LM Studio.

## Use the first release

- **Conversation** stores each turn and shows provider failures. Send `/remember Use metric units` or `/commit Review the meeting notes` to explicitly save an entry, even offline. Ordinary model replies can suggest a preference or commitment. Saving it requires owner input.
- **Memory** lets you add, edit and remove preferences and mark commitments complete or open. Memory and conversation use the profile's scope. Editing memory affects the context supplied on future turns. The transcript retains what was said. The model receives bounded recent context, while you can page through the full transcript.
- **Follow-ups** lets you approve a one-time, daily or weekly reminder or tool check. Choose its first local time, IANA timezone, read tool and arguments, execution budget, and notification condition. A reminder uses its goal as the notification body. A tool check executes its approved read. Pause, resume or cancel jobs here.
- **Inbox** contains in-app deliveries and approvals. A proposed external action displays its tool, destination and full arguments. The owner approves or rejects that stored operation. Every external effect requires fresh approval in v1. The installed tools only read data or calculate a result.

For a restart demonstration, save an open commitment, schedule `list_commitments` with `{}` and **Only when the tool finds items**, then restart the service before the due time. One inbox entry appears for the matching run. Once you complete the commitment, an identical check records a quiet run. The process-level test automates both outcomes and recovery from abrupt termination. [Detailed scheduling semantics](docs/scheduler.md)

The **Focus planner** sample demonstrates an independently installed specialty. Its read tool divides a time allowance into blocks. With 80 minutes and 25-minute blocks, a scheduled check returns three blocks and five minutes remaining. Its profile, implementation and operator grant are separate files. [Sample profile](config/profiles/focus.json) · [Sample tool](extensions/estimate-blocks.mjs) · [Grants](config/policy.json)

## Operate and test

`docker compose ps` shows health and the loopback port binding. Use `docker compose logs --tail 30 clockwork` for startup diagnostics. The health check covers the application and is independent of model availability. Rebuild after changing application code. Restart after changing a profile, policy or installed extension.

SQLite lives at `/data/clockwork.sqlite` in the named `clockwork_data` volume. Container recreation preserves it. For a consistent backup, stop the service, copy its data directory, then start it again. Keep the backup, configuration, extensions and secrets private. Removing the data volume with `docker compose down -v` erases the database.

```powershell
docker compose stop clockwork
docker compose cp clockwork:/data ./clockwork-backup
docker compose start clockwork
```

Run the tests with Node 24 from the project root, or inside the Compose image. No package installation, model download, API key or live model is needed for the suite.

```powershell
node --test
# Docker-only alternative after building the image
docker compose run --rm --no-deps -v ./test:/app/test:ro clockwork node --test
```

The tests cover HTTP authentication and scope changes, both provider wire formats, timeout and failure isolation, malformed calls, exact-action approvals, DST transitions, deadlines, retries and duplicate suppression. The recovery test boots the actual server with a temporary database, approves work over HTTP, kills it and checks run and inbox identities across restarts. Hosted responses are simulated. LM Studio protocol tests use a loopback HTTP fixture.

For development without Docker, use Node 24, set `CLOCKWORK_PASSWORD_FILE` to the generated password file and `CLOCKWORK_LM_BASE_URL` to the model server's host-reachable address, then run `node src/server.mjs`. This entry point reads process environment variables directly. It binds to loopback and stores SQLite under `data/` by default. The Compose configuration loads `.env`.
