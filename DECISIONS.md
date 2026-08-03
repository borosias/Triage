# Decisions

## 1. Make PostgreSQL the concurrency boundary for claiming

### Context

R1 requires two members claiming the same Item at the same time to produce exactly one winner. This has to hold under real concurrency, including requests handled by different Vercel instances.

The obvious implementation is:

1. `SELECT` the Item.
2. Check that `claimedById` is null.
3. `UPDATE` it.

That creates a race because two requests can both observe the same unclaimed state before either update commits.

### Choice

Claiming is implemented as one conditional PostgreSQL `UPDATE ... RETURNING`.

The claim predicate and the state transition are part of the same database statement. PostgreSQL serializes concurrent updates to the same tuple and re-evaluates the conditional update against the current row state, so only one request can successfully transition an available Item into a claimed Item.

The application does not use an in-memory mutex or rely on request ordering. A failed conditional update is followed by a canonical read so the loser can return `409` together with the current Item and claimant for UI reconciliation. That fallback read is canonical at the time it runs, but it is not an atomic snapshot tied to the failed `UPDATE`; a later concurrent mutation can still change the Item.

R5 later extended the same predicate with lease-age semantics rather than replacing this concurrency boundary.

### Strongest rejected alternative

A read/check/write transaction around `SELECT -> check -> UPDATE`.

### What ruled it out

Under the default transaction behavior, the read still creates an intermediate state in which two requests can both decide that the Item is available. Making that approach correct would require explicit locking or stronger transaction semantics while still being more complicated than expressing the state transition directly as a conditional update.

The correctness condition belongs naturally in the write itself.

### Cost

The mutation uses PostgreSQL-specific SQL rather than staying entirely inside Prisma's higher-level API. Conflict responses also require a canonical read after a failed update.

That is more database-coupled, but the coupling is intentional: the database is the component that can actually serialize concurrent writes.

### When this becomes wrong

This design would need to change if one Item could be concurrently writable across independent databases or multiple writable shards where one PostgreSQL tuple is no longer the serialization point.

At that point the claim protocol would need a partition-aware ownership mechanism or another coordination boundary rather than assuming one authoritative row.


## 2. Enforce workspace isolation at the server and again at the mutation boundary

### Context

R2 assumes hostile API use, not just a cooperative UI. A user can paste an Item ID into curl, and a VIEWER must be able to read while being unable to claim, release or resolve.

The important failure mode is therefore not a missing button. It is an otherwise valid authenticated request reaching an Item through the wrong workspace or role.

### Choice

Every workspace route authenticates the user and resolves membership before performing workspace work.

Reads are scoped by `workspaceId`. Mutations additionally repeat workspace membership and allowed role predicates inside the conditional database update itself. OWNER and MEMBER may mutate; VIEWER is rejected with `403`. Missing membership or a resource outside the requested workspace is returned as `404` rather than exposing whether that resource exists elsewhere.

For R5, authorization is intentionally performed before the stale-claim sweep. An unauthorized request must not be able to cause housekeeping writes in another workspace.

### Strongest rejected alternative

Perform one application-level membership check and then address Items globally by `itemId` in subsequent reads or writes.

### What ruled it out

That makes correctness depend on every route remembering that the Item itself must still belong to the authorized workspace.

It is exactly the kind of boundary that fails when somebody supplies a valid Item ID through a different workspace route. Keeping `workspaceId` and membership predicates at the actual query/update boundary makes a forgotten UI restriction irrelevant.

### Cost

The authorization logic is intentionally explicit and somewhat repetitive across the routes. Some mutations contain predicates that duplicate information already checked immediately beforehand.

There is also one explicit take-home assumption: workspace memberships are static. Mutation SQL repeats membership and role checks, but route prechecks, reads, and stale-claim housekeeping do not provide instantaneous revocation if membership is changed concurrently outside the application. If memberships became mutable, I would bind housekeeping/read authorization to the same transaction/predicate or move that invariant into a dedicated policy/RLS layer.

### When this becomes wrong

With many more resources, roles, entry points, or non-HTTP database consumers, repeating authorization predicates route by route would become harder to audit than a centralized policy system.

At that point I would consider moving the invariant into a dedicated authorization layer or PostgreSQL RLS while keeping resource scoping close to the database boundary.


## 3. Trigger notification attempts from committed database state, not from the browser

### Context

R3 deliberately makes `notify()` slow and unreliable: it waits about one second and throws roughly 20% of the time.

Resolve must return without waiting for it, the attempt must not disappear silently, and a Vercel process cannot be assumed to continue running after the response.

The requested guarantee is therefore not "make notifications reliable", but to choose and state an honest delivery contract.

### Choice

After route-level authorization, Resolve runs one short database transaction: the R5 stale-claim sweep, the conditional resolve `UPDATE`, and—only after a successful resolve—the `NotificationDelivery` insert. The Item transition and delivery record therefore commit or roll back together.

The committed delivery starts as `PENDING`. When the deployment webhook is configured, a Supabase Database Webhook on `NotificationDelivery INSERT` calls a Vercel worker. The worker atomically acquires the record with a `PENDING -> PROCESSING` compare-and-set, executes one `notify()` attempt for that acquired record, and stores either `SENT` or `FAILED`.

The guarantee is **best-effort-with-a-record**.

Known failure windows are kept visible:

- a webhook that never reaches the worker leaves the record `PENDING`;
- a worker that dies after acquisition can leave it `PROCESSING`;
- `notify()` may succeed while the following `SENT` write fails, leaving an ambiguous `PROCESSING` record;
- `FAILED` is terminal;
- exactly-once and guaranteed delivery are not claimed.

### Strongest rejected alternative

Trigger the dispatch from the client immediately after a successful Resolve response.

This was initially attractive because it kept the server path short and required no additional worker trigger.

### What ruled it out

A successful Resolve made through curl would never run the browser dispatch. The same problem appears if a user closes the tab immediately after Resolve.

That could leave a durable `PENDING` record without ever initiating an attempt. The trigger therefore has to originate from committed server-side state rather than from the client that happened to create it.

I also rejected continuing work after returning the Resolve response because the assignment explicitly requires that no serverless process still be relied on after the response.

### Cost

The design requires production webhook configuration and introduces failure states that a real delivery system would normally retry or reconcile.

I deliberately did not add those retries because the requirement says to live with the unreliable `notify()` rather than turn the exercise into a reliable messaging system.

### When this becomes wrong

If notifications become business-critical, `PENDING` and `PROCESSING` records cannot be allowed to remain indefinitely.

I would replace the single-attempt webhook path with a durable outbox/queue consumer with retry policy, recovery of abandoned processing records, idempotency at the external side effect, observability and a dead-letter strategy. The delivery guarantee would then need to be renamed accordingly.


## 4. Expire claims lazily on authorized traffic while keeping lease checks in every mutation

### Context

R5 says a claim older than 30 minutes returns to the queue, but Vercel has no continuously running daemon.

The underdetermined part is who performs physical cleanup and what happens when a Resolve arrives after the lease has expired.

### Choice

Claim expiration is request-driven.

The first valid, authorized queue or Item interaction after a claim becomes stale runs an awaited, idempotent, workspace-scoped sweep before observing or mutating queue state. Staleness is determined by PostgreSQL time:

`claimedAt < CURRENT_TIMESTAMP - INTERVAL '30 minutes'`

The comparison is deliberately strict: exactly 30:00 is still active; only a claim older than 30 minutes is stale. In mutation transactions, PostgreSQL `CURRENT_TIMESTAMP` is the transaction-time clock shared by the sweep and mutation predicates.

The sweep is only physical normalization. Mutation correctness does not depend on the sweep having happened first: claim, release and resolve also enforce lease freshness atomically in their own database predicates.

A Resolve processed after its current claim has expired returns `409`, leaves the Item `OPEN`, creates no `NotificationDelivery`, and requires the user to claim again.

### Strongest rejected alternative

Run claim expiration from a periodic scheduler or cron job.

### What ruled it out

For the take-home workload, a scheduler adds another execution mechanism, configuration surface and timing model even though correctness can already be enforced at the mutation boundary.

Request-driven cleanup keeps the serverless deployment self-contained and means the request that needs canonical queue state can normalize that state synchronously.

### Cost

Physical cleanup is lazy. With no traffic, stale `claimedById` and `claimedAt` values may remain stored until the next authorized interaction.

Under active traffic, the opposite cost appears: many requests may execute a sweep that updates zero rows. That is acceptable at this scale but would become wasteful at high request rates.

The implementation also has no per-lease fencing token. Mutations are authorized against the current claim state. If the same user lets lease A expire, successfully acquires lease B, and only then a delayed request from lease A arrives, the server cannot distinguish that old request from an action against lease B.

That limitation is documented rather than hidden.

### When this becomes wrong

At materially higher traffic, for example around 1000 requests per second, running a sweep on every relevant request becomes unnecessary write/query amplification. I would move physical cleanup to a scheduled or coalesced database job while retaining the lease-age predicate inside mutations.

If the product later requires historical lease identity or protection against delayed requests from an older lease, I would add a claim generation/token and require mutations to present that lease identity.


# Deliberate non-dos

1. **No client-side deduplication for R4 pages.** I deliberately did not deduplicate appended Items by `item.id`. If the backend ever repeats a row across pagination boundaries, UI deduplication would hide an R4 correctness bug. The verifier is responsible for proving that the backend traversal has no duplicates.

2. **No per-lease fencing token for R5.** A claim generation would close the same-user expire/reclaim/delayed-request ABA case, but it would expand the schema, API and client contract for an optional requirement. The current limitation is stated explicitly instead of claiming a guarantee the implementation does not provide.

3. **No retries or recovery scheduler for R3 notifications.** Retrying `FAILED`, recovering abandoned `PROCESSING`, or repeatedly dispatching `PENDING` would turn the exercise into a stronger delivery system than requested. The implementation performs one attempt and persists the result or the failure window honestly.


# First refactor on a real project

I would first extract the repeated `claim` / `release` / `resolve` orchestration into a small typed application-service layer while keeping the SQL transitions explicit; I left it duplicated because the take-home was easier to audit with the R1/R2/R5 invariants visible directly in each route.


# Time spent

Approximately **20 hours**.