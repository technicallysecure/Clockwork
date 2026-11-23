# Use my ChatGPT plan

An eligible ChatGPT account can power Clockwork's text chat and application tools. Plan usage draws on the allowance or credits you authorize in ChatGPT. An active subscription, successful identity sign-in and permission to invoke models are separate things. The account's live model catalog determines which models you can select. [OpenAI walkthrough](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt) · [Plan usage](https://developers.openai.com/siwc/token-sharing-open-source)

## Enable on Core‑2

Keep the existing Compose project name, volumes, password and worker secrets. In its private `.env`, set `CLOCKWORK_LOCAL_ONLY=false` to permit hosted selection. Keep `CLOCKWORK_DEFAULT_PROFILE=local` to start new agents on LM Studio. The opt-in Compose file adds a loopback callback and a private credential volume to each worker. Run the same pair of Compose files on subsequent updates.

```powershell
docker compose -f compose.yaml -f compose.plan.yaml up -d --build --wait
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-isolation.ps1
```

On Core‑2 the browser opens the Clockwork UI on [port 12002](http://127.0.0.1:12002). New installations can set `CLOCKWORK_HOST_PORT=12002` to use that address. The sign-in button opens OpenAI in the browser. OpenAI redirects to `http://127.0.0.1:12003/auth/callback`. Docker Desktop forwards that Windows loopback port to a dedicated listener in the gateway. The gateway matches a short-lived, single-use state to the originating worker. Restarting mid-sign-in requires a fresh attempt. Set `CLOCKWORK_PLAN_CALLBACK_PORT` to another free port if necessary.

For remote access, the simplest option is to use the browser on Core‑2 through a private remote desktop. From a browser on a different computer, establish both local forwards over your existing private SSH connection to Core‑2. Then open the same loopback UI URL on that computer. Keep the tunnel running through the callback. A reverse proxy that serves the UI alone cannot receive a redirect addressed to the browser's loopback. Keep the callback off public proxies and firewall rules. This setup uses browser loopback and SSH forwarding with code exchange on Core‑2. [OpenAI loopback registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)

```sh
ssh -N -L 127.0.0.1:12002:127.0.0.1:12002 -L 127.0.0.1:12003:127.0.0.1:12003 your-user@Core-2
```

For standalone Node, set `CLOCKWORK_LOCAL_ONLY=false` and `CLOCKWORK_PLAN_CALLBACK_PORT=12003` before starting. The native callback binds directly to IPv4 loopback. The protected store defaults to `~/.clockwork/plan/<agent-id>`. `CLOCKWORK_PLAN_VAULT` can point to a dedicated private directory outside the project, workspace and application data.

## Manual smoke test with a real account

1. Sign in to Clockwork with the owner password. Select an agent, open **Agent settings**, and choose **Use my ChatGPT plan**.
2. Choose **Continue with ChatGPT**. In OpenAI's browser flow select the correct account and workspace, review usage permissions and approve. Return to Clockwork Settings and refresh the connection. Check the selected registration and look for both `resource.invoke` and `chatgpt.tokens.use.direct` under granted permissions. If only identity was granted, choose **Enable plan usage**.
3. Settings loads the eligible models for this account. Pick a listed model and save the settings. Check that chat shows the plan provider and model.
4. Send `Reply with exactly: Clockwork plan smoke test passed.` Verify the completed assistant reply in the conversation. The worker reads the upstream event stream through `response.completed` before saving the answer. Closing the stream early must show an error. Clockwork displays the finished turn as a single message.
5. For a tool-capable listed model, enable native calls, then send `Use estimate_blocks with minutes 55 and blockMinutes 20. Report the tool's result.` Expect two whole blocks and 15 minutes remaining. A correct calculation alone does not prove a tool executed. The integration test inspects the actual function call, validated result, matching call ID and final stream.
6. Select **Manage usage** to inspect the account's app allowance in ChatGPT. Sign out in Clockwork and try another message. The plan provider should request reconnection. The API-key provider requires a separate, explicit selection.

## Credentials and availability

The worker generates a UUID installation ID before registration. Dynamic registration yields an issued client ID bound to a user and workspace. Reconnect uses that registration and verifies the subject. Each sign-in validates state, the S256 verifier exchange, the signed ID token and nonce, and the scopes in the token response. Inference requires both `resource.invoke` and `chatgpt.tokens.use.direct`. The worker requests `offline_access` for renewal. The owner password continues to control access to Clockwork. [Registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) · [Sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)

Each worker has its own encrypted vault under `/plan-secrets`. The key and encrypted database need the same private backup protections as the agent's secrets. On Linux the directory is owner-only and the key and vault files have mode 0600. Native Windows wraps the vault key with CurrentUser DPAPI. Reuse the original volume for that agent across upgrades. Losing it requires reconnecting and creates a new installation identity. Sign-out removes local tokens and attempts refresh-token revocation. If remote revocation cannot be confirmed, disconnect the app in ChatGPT Settings.

The worker lists eligible models using `GET /v1/models` and sends stateless HTTP/SSE requests to the public `POST /v1/responses`. Every inference request uses `store: false` and `stream: true`. Supported app functions use one namespace and pass through Clockwork's registry. The adapter surfaces declined grants, quota, interrupted streams and unsupported capabilities. For plan limits, open [Manage usage](https://chatgpt.com/settings/usage). [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) · [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

## Automated verification

Run `node --test` from the repository with Node 24 or later. The suite uses fake credentials, a signed test identity and mocked OpenAI transports. It exercises callback validation, registration binding, consent, renewal, revocation, catalog filtering, fragmented SSE and error events, the application tool round trip, approval checks, local context isolation after restarts, and both existing providers. A live account and owner consent are needed to complete the manual test above.

On November 23, 2026, a separate Docker Desktop deployment on Core‑2 completed the browser flow in Edge using a mock issuer and a mock Responses service. Identity-only consent blocked model discovery. With plan permission, the picker listed the eligible model and the worker passed the result of `estimate_blocks(83, 20)` back to that model. The transcript showed four blocks with three minutes left. Switching from LM Studio left the local goal out of the hosted settings. The test also exercised the loopback callback, renewal and sign-out. Real-account model availability and plan usage still require the manual smoke test above.

For this release, all 68 tests passed on Windows and in the Linux image with outbound networking disabled. A separate Docker Desktop Compose deployment passed the isolation check for three workers and nine private volumes. Its authenticated web API generated the authorization URL with the expected loopback mapping. A browser test with simulated responses exercised identity-only consent, model selection and saving the plan provider. Live OpenAI sign-in, subscription availability and real inference remain unverified.
