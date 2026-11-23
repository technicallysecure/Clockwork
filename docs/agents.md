# Running isolated agents

The Compose deployment has one owner-facing gateway and one runtime container per agent. The gateway publishes the web interface on `127.0.0.1:8787` and authenticates the owner. It routes requests to a fixed list of worker services. Each worker runs its own scheduler and owns its SQLite database, workspace, provider settings, conversations, memory, approvals and inbox.

| Service | Agent ID | Database volume | Workspace volume |
| --- | --- | --- | --- |
| `clockwork` | `personal` | `clockwork_data` | `personal_workspace` |
| `worker-agent-2` | `agent-2` | `agent-2_data` | `agent-2_workspace` |
| `worker-agent-3` | `agent-3` | `agent-3_data` | `agent-3_workspace` |

Docker adds the Compose project name to the volume names. The gateway has access to the owner password and its per-worker routing tokens. It has no agent volume mounts. The only token mounted in a secondary worker is its own routing token. The personal worker also receives the legacy inference secret files. Each secondary worker starts with independent provider credentials that the owner can set in its web settings.

Docker attaches each worker to a distinct bridge network shared with the gateway. Workers have outbound access for their configured inference endpoint. They run as the `node` user with a read-only root filesystem and all Linux capabilities dropped. The database and workspace are mounted at `/data` and `/workspace`. Configuration and installed extension code are operator-managed, read-only mounts. Install trusted extensions because an in-process extension runs with its own worker's privileges. The gateway and workers operate without access to the Docker daemon. [Compose networks](https://docs.docker.com/reference/compose-file/networks/) · [Service secrets](https://docs.docker.com/reference/compose-file/secrets/)

## Start or upgrade

From the existing project directory on Core‑2, use the same Compose project name as the previous installation. The `clockwork` service keeps the original `clockwork_data` volume and becomes the personal worker. The other workers begin as empty slots. Running setup again creates missing routing tokens and preserves existing passwords, keys and local defaults.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
docker compose up -d --build --wait
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-isolation.ps1
```

Sign in with the existing owner password and open the agent controls to activate another worker. Give it a name and a goal. A new slot is ready to use as soon as the owner activates it. Its immutable ID determines its Docker resources. Renaming the agent keeps its volume bindings intact. Provider and profile choices apply within the selected agent. The operator deployment setting `CLOCKWORK_LOCAL_ONLY=true` limits every agent to local inference.

The isolation check inspects container configuration, per-worker networks, volume bindings, port publishing and scoped secret grants. Pass `-ProjectName <name>` when inspecting a separately named Compose project.

## Assignment retries

When assigning work to multiple agents, the gateway sends the same request ID with each selected agent's profile and settings revision. Each worker records its own outcome. An identical retry returns a completed worker's saved result and can reach workers that were offline or busy before starting. If a worker stopped mid-assignment, check its conversation and commitments before issuing a new request. A recorded provider failure is also returned on replay.

## Add another worker

The gateway discovers its allowed slots from the Compose configuration. To add a fourth one, use a unique lowercase ID such as `research`. Use the same spelling for its service alias, routing token, ID, network and volume prefixes.

1. In `compose.yaml`, copy the entire `worker-agent-3` service and replace every `agent-3` in that copy with `research`. This creates `worker-research` with its own credentials, named volumes and network. Keep the shared worker defaults, including `CLOCKWORK_AGENT_RESERVED`.
2. Add `research` to the gateway's `CLOCKWORK_AGENT_SLOTS` and `networks`. Add `worker-research` to its `depends_on` and `worker_research` to its `secrets`.
3. At the top level, declare the `research` network, `research_data` and `research_workspace` volumes, and a `worker_research` secret with `file: ./.secrets/worker_research`.
4. Run the commands below and activate the new slot from the web interface.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -AdditionalSlots research
docker compose config --quiet
docker compose up -d --build --wait
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-isolation.ps1
```

Each database and workspace records its owning agent ID. The worker checks both before serving requests. Keep its volumes and routing secret associated with the same ID across upgrades. A workspace backup must include the hidden `.clockwork-agent-id` file. To rotate a routing token, generate a fresh high-entropy secret for that slot, replace its local token file, then recreate the worker and gateway together.

## Backup and operations

Back up both volumes of each agent and include the operator configuration and routing secrets in a protected backup. Each agent's data directory contains private conversations, commitments, settings and the key file for credentials entered in the UI. Restore the entire data directory together. For a consistent per-agent copy, stop only that worker, copy its volumes, and restart it. This example uses a new backup directory in the project root.

```powershell
New-Item -ItemType Directory .\backup-agent-2
docker compose stop worker-agent-2
docker compose cp worker-agent-2:/data .\backup-agent-2\data
docker compose cp worker-agent-2:/workspace .\backup-agent-2\workspace
docker compose start worker-agent-2
```

Use `docker compose ps` for worker health and `docker compose logs --tail 30 gateway` for gateway diagnostics. Each worker processes outstanding follow-ups when it resumes. Stopping the gateway temporarily prevents browser access while worker schedulers continue to run. Removing Compose volumes erases agent records and workspaces.

Running `node src/server.mjs` directly with the existing password configuration starts one local development runtime. Use the Compose gateway and workers for container isolation.
