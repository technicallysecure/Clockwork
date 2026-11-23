# Scheduled follow-ups

Select the profile, open Follow-ups, enter the goal, choose a local date and IANA timezone, then approve the schedule. A plain reminder uses the goal as its inbox message. A check runs the selected read tool with the saved JSON arguments. Each job pins its profile and allowed tools. The runtime checks current profile permissions again at execution.

Clients can include a UUID `requestId` on `POST /api/jobs`. Keep it with the approved form when retrying a lost response. Clockwork saves the ID and job together, so replaying the same specification preserves the original job, even after it has completed or the server restarts. Reusing the ID for a changed specification returns HTTP 409. A new approval can use a fresh UUID. Requests that omit the ID create a job on each call.

| Notification rule | Inbox behavior on a successful run |
| --- | --- |
| After each successful run | Deliver one reminder or the read tool's JSON result, up to 4,000 characters. |
| Only when the tool finds items | Deliver when the read returns a nonempty array, a nonempty `items` array, or a positive integer `count`. When both fields exist, `items` takes precedence. An incompatible result shape fails the run. |
| Never — keep a run record | Record the run and keep the inbox quiet. |

## Try a conditional follow-up

1. Save an open commitment in the selected profile's memory scope.
2. Open **Follow-ups**, choose **Schedule follow-up**, and set the first scheduled time a minute from now. Enter “Review open commitments” as the goal. Choose `list_commitments` under **Allowed tool**, use `{}` as its arguments, and select **Only when the tool finds items**. Click **Approve schedule**.
3. Restart the container with `docker compose restart`. Sign in again after the due time and open the inbox to see the result. Restart again and inspect the same run and notification IDs through the authenticated `GET /api/state` endpoint.
4. Mark the commitments in that scope complete and repeat the job. Run history records a quiet result.

A reusable workflow can be a new job specification made from installed tools. For example, the form in step 2 can run every Monday at 09:00 by choosing a Monday start date and weekly recurrence. A new read tool can supply its own `items` or `count` for the same rule.

## Calendar behavior

- The first occurrence uses the saved local date, time and timezone. A time already in the past becomes due immediately. Future daily or weekly occurrences retain the same local clock reading.
- At a fall-back fold the earlier instant wins. An initial time in a spring-forward gap is rejected. Subsequent recurrences skip that nonexistent local time.
- After downtime, the worker handles the earliest outstanding occurrence once, then advances to the first future occurrence. A weekly check missed over several weeks produces at most one catch-up notification.
- Pause retains the outstanding occurrence. Resume makes it eligible again. Cancel ends the job. Decisions that win the database transaction before delivery invalidate the old worker's claim. Completed runs and inbox records remain available.

## Execution and recovery

The worker polls every second and claims one due job at a time. The unique occurrence identity is the job ID plus its UTC due instant. A four-second renewable lease lets a replacement worker claim an interrupted read. Each claim has a fresh token. An old worker cannot complete a newer worker's claim.

One occurrence has a total active execution budget of 1–600 seconds. A read receives an abort signal at its deadline. A late result is discarded, even if a tool returns after cancellation. Trusted in-process tools should honor the signal and avoid blocking the event loop. Retry delays and container downtime after the last live lease consume no execution time. A crash conservatively charges the remainder of the live lease against the budget.

Transient errors can be retried up to three attempts with one- and two-second waits. Invalid conditions and revoked permissions fail the run. A terminal failure stays in run history and generates no notification. For a recurring job, later occurrences remain scheduled. The worker performs only read operations and may repeat a read after interruption.

The inbox record, run outcome and next due instant commit in one SQLite transaction. A unique constraint on the inbox run ID enforces one delivery per run across retries and restarts. SQLite history and notifications are the delivery record. Refreshing the web UI reads the same records.

The scheduler accepts a `createDelivery(db)` factory. Its default implementation is `createInbox` in `src/inbox.mjs`. A local delivery adapter implements synchronous `deliver({runId, jobId, goal, body, createdAt})` and `list()`. Delivery uses the supplied SQLite connection inside the active completion transaction. It deduplicates by `runId`, uses epoch milliseconds for the incoming timestamp, and throws to roll back on failure. The list returns persisted entries newest first, with an entry ID and ISO timestamp. External delivery requires a separate approved action.

Run `node --test test/process-recovery.test.mjs` for the end-to-end recovery check. It uses a temporary database, the real HTTP channel and worker, three process kills, and an advancing test clock to exercise two calendar days.
