# Flamingo

Flamingo Home Assignment implementation with atomic item claiming, sealed
workspace access, durable notification records, stable keyset pagination, and
request-driven stale-claim expiration.

**Live:** https://triage-two-theta.vercel.app
**Repository:** https://github.com/borosias/Triage

## Requirements

- Node.js 20.19.0 or newer
- npm

## Local setup

```powershell
npm install
Copy-Item .env.example .env.local
```

Configure the database URLs and server secrets in `.env.local`:

- `DATABASE_URL`: the Supabase transaction pooler URL used by the serverless application runtime.
- `DIRECT_URL`: the Supabase direct database URL used by Prisma migrations. If the direct IPv6 endpoint is unavailable locally, use the Supabase session pooler URL instead.
- `SESSION_SECRET`: a private random value of at least 32 characters used to sign the local login cookie.
- `NOTIFICATION_WEBHOOK_SECRET`: a private random value of at least 32 characters shared only by the Supabase Database Webhook and the internal notification worker.

Generate the Prisma Client and apply committed migrations:

```powershell
npx prisma generate
npx prisma migrate deploy
```

Seed the development database and verify the resulting fixtures:

```powershell
npm run seed
npm run seed:verify
npm run dev
```

`npm run seed` is a destructive development-only operation. It resets
`NotificationDelivery`, `Item`, `WorkspaceMembership`, `Workspace`, and `User`
before recreating four users, two workspaces, six memberships, and 10,000
deterministic items. Prisma migration metadata, schemas, and extensions are not
removed. The seed uses `DIRECT_URL` and is intended to be repeatable rather than
append data across runs.

## Local login

Open the application and choose Alice, Bob, Carol, or Dana from the dropdown.
The users come from the seeded `User` table. The selection creates an eight-hour
signed, HttpOnly session cookie; use **Log out** to clear it. This is the
assignment's intentionally fake login and does not implement real authentication.

With the development server running on port 3000, verify the session flow with:

```powershell
npm run session:verify
```

## Workspace-scoped queue reads, claims, release, and resolve

Authenticated users can list only workspaces where they have a database-backed
membership. Selecting one loads the first 50 newest `OPEN` items from that
workspace, including both claimed and unclaimed items. `OWNER`, `MEMBER`, and
`VIEWER` can all read. A request for a workspace without membership returns
`404`, and every item query includes the requested workspace ID in its database
predicate.

`OWNER` and `MEMBER` may claim an unclaimed `OPEN` item. `VIEWER` cannot claim,
and item IDs cannot cross workspace boundaries. Claiming uses one conditional
PostgreSQL `UPDATE ... RETURNING`; the item, workspace, state, unclaimed check,
membership, and write-capable role are all part of that mutation predicate.

The same write-capable roles may release only their own claim on an `OPEN` item.
Release clears both claim fields in one conditional `UPDATE ... RETURNING`, with
item identity, workspace boundary, open state, claim ownership, membership, and
role enforced by that statement.

They may also resolve only their own active claim on an `OPEN` item. After the
route-level session, membership, and role checks, Resolve uses a short Prisma
interactive transaction: it first performs the R5 workspace-scoped stale-claim
sweep, then a conditional PostgreSQL mutation enforces Item identity, workspace
boundary, state, claimant, lease freshness, membership, and role. On success,
the same transaction inserts one `PENDING` `NotificationDelivery`. If that
insert fails, the resolve mutation and the sweep roll back together.

The queue waits for claim, release, and resolve responses before changing a row.
A `200` response displays the confirmed state, while a `409` immediately
reconciles the row to the canonical Item returned by the server. That conflict
Item is a later fallback read, not an atomic snapshot tied to the failed update;
another mutation can still change it afterward. Successful resolve removes the
Item from the OPEN queue and reports `Resolved. Notification queued.` without
waiting for notification delivery.

With the development server running on port 3000, verify the R2 read contracts
and seeded visibility matrix with:

```powershell
npm run r2:verify
```

The verifier covers both queue reads and adversarial claim writes, including
`OWNER`, `MEMBER`, `VIEWER`, non-member, and mismatched workspace/item-ID cases.

## Concurrent claim verification

With the development server running on port 3000, run:

```powershell
npm run r1:verify
```

The verifier obtains a real seeded item through HTTP, resets only that item to
an unclaimed `OPEN` state, establishes Alice and Bob sessions, sends both claim
requests concurrently, and requires exactly one `200` and one `409`. It then
checks that the conflict response names the winner and reads PostgreSQL directly
to confirm the same claimant. The test item is restored afterward.

## Atomic release verification

With the development server running on port 3000, run:

```powershell
npm run release:verify
```

The verifier uses real signed sessions for owner, member, viewer, and outsider
requests. It checks release ownership, repeated release, cross-workspace ID
substitution, canonical unclaimed state, and direct database non-mutation for
failed requests. Every touched item is restored to its original claim state.

## R3 notification delivery guarantee

The implemented guarantee is **best-effort-with-a-record**.

Resolve durably commits both the resolved Item and a `PENDING` delivery record,
then returns without calling or waiting for `notify()`. When the Supabase
Database Webhook described below is configured, the committed INSERT triggers a
separate Vercel invocation. The internal worker reloads canonical delivery data
by delivery ID, atomically acquires only `PENDING -> PROCESSING`, and makes one
attempt. `notify()` waits about one second and fails on roughly 20% of calls.
Success stores `SENT`; a normal notify failure stores `FAILED` with a short
non-sensitive error value.

There are no application retries:

- `PENDING` may remain indefinitely if the database webhook never reaches the worker.
- `PROCESSING` may remain indefinitely if the worker dies during the attempt.
- `PROCESSING` is ambiguous if `notify()` performed its side effect but `SENT` could not be stored.
- `FAILED` is terminal and is never changed back to `PENDING`.
- Duplicate webhook calls cannot acquire `PROCESSING`, `SENT`, or `FAILED`, so they do not make another notification attempt.

This is not guaranteed delivery and is not an exactly-once guarantee. The
database row is the durable source of truth; the webhook is only a best-effort
trigger.

### Supabase Database Webhook setup

Set the same private `NOTIFICATION_WEBHOOK_SECRET` in the Vercel deployment and
the Supabase webhook configuration. Never prefix it with `NEXT_PUBLIC_`.

In the Supabase Dashboard, create a Database Webhook with:

- schema and table: `public.NotificationDelivery`
- event: `INSERT` only
- HTTP method: `POST`
- destination: `https://<deployment>/api/internal/notifications/dispatch`
- header: `Content-Type: application/json`
- header: `x-notification-webhook-secret: <NOTIFICATION_WEBHOOK_SECRET>`

Do not store the deployed URL or real secret in source code or a Prisma
migration. Local verification does not require a configured remote webhook; it sends a
representative Supabase INSERT payload directly to the internal worker. For a
deterministic `r3:verify` run, use a development/test database where an external
`NotificationDelivery` webhook is not simultaneously consuming the same rows.
The deployed webhook path is a separate integration check.

With the development server running and the same webhook secret available to
both server and verifier, run:

```powershell
npm run r3:verify
```

The verifier uses real signed sessions and direct PostgreSQL assertions. It
covers resolve roles and isolation, the Item-plus-delivery transaction result,
secret and payload validation, one CAS acquisition, terminal `SENT | FAILED`,
duplicate no-op behavior, safe failure storage, and fixture restoration.

Claim expiry is not included in this slice.

## R4 stable queue pagination

The queue uses **stateless composite keyset/seek pagination** ordered by
`(createdAt DESC, id DESC)`. `createdAt` is the business ordering value, while
the unique `id` tie-breaker makes every boundary deterministic when timestamps
match. The production route never uses `OFFSET` and never fetches the whole
queue.

The API contract is:

```text
GET /api/workspaces/:workspaceId/items
GET /api/workspaces/:workspaceId/items?cursor=<opaque>
```

Both forms return `{ items, nextCursor }`. Each page query requests 51 result
rows and exposes at most 50 Items, and returns `nextCursor: null` after
the final page. A continuation applies the parameterized PostgreSQL predicate:

```sql
("createdAt", "id") < ($cursorCreatedAt::timestamptz, $cursorId::uuid)
```

The opaque base64url JSON cursor is versioned and bound to the workspace. It
contains `v`, `workspaceId`, `createdAt`, and `id`, but is not an authorization
boundary. The route validates its size, encoding, strict structure, version,
UUIDs, exact timestamp form, and workspace binding after the existing R2
membership check. PostgreSQL formats the cursor timestamp as UTC text with six
fractional digits. That exact `TIMESTAMPTZ(6)` value is never constructed from
or rounded through a JavaScript `Date`.

The Item access path is the normal composite index
`(workspaceId, status, createdAt DESC, id DESC)`. The UI keeps the dense table,
stores `nextCursor`, and appends the next page through **Load more**. Continuation
loading and Item mutations are mutually excluded: Item actions are disabled while
a continuation is in flight, and **Load more** is disabled while an Item action
is pending. A continuation error leaves existing rows visible and can be
retried. Changing workspace starts a new traversal and invalidates in-flight
continuation responses before they can append to the new workspace.

This is not a database snapshot across HTTP requests. Resolving a row before it
is reached removes it from the remaining `OPEN` traversal. An Item inserted
after traversal starts with a key ahead of the current cursor is not seen until
refresh; an artificially older inserted key behind the cursor can appear later.
Each SELECT sees current database state. The implementation therefore does not
promise that every row present on page 1 will be returned, or exactly-once
observation of a changing dataset.

With the development server running, execute the HTTP and PostgreSQL regression
scenarios with:

```powershell
npm run r4:verify
```

The verifier covers bounded full traversal, exact database ordering, repeated
IDs, strict page boundaries, malformed and cross-workspace cursors, all R2
roles, the literal OFFSET-shift resolve scenario, a later-page claim, a resolved
cursor Item, two same-millisecond microsecond timestamps across a page boundary,
and the documented new-row limitation. Every temporary fixture workspace is
deleted in `finally`.

Run the read-only deep-page comparison on the real seeded database with:

```powershell
npm run r4:explain
```

The following is a recorded `EXPLAIN ANALYZE` capture against the final schema
and the same final index for both queries. Row counts, boundaries, buffer counts,
and absolute timings can change as the database is mutated by verification or
normal use; the structural comparison is the part that matters:

```text
Workspace: 10000000-0000-4000-8000-000000000001
Matching OPEN rows: 5588
Deep offset: 4191
Equivalent keyset boundary: (2024-07-01T04:41:02.000000Z, 20000000-0000-4000-8000-000000000b1e)

Naive OFFSET plan:

Limit  (cost=403.84..408.66 rows=50 width=208) (actual time=8.804..8.905 rows=50 loops=1)
  Buffers: shared hit=4272
  ->  Nested Loop Left Join  (cost=0.45..538.41 rows=5589 width=208) (actual time=0.031..8.676 rows=4241 loops=1)
        Buffers: shared hit=4272
        ->  Index Scan using "Item_workspaceId_status_createdAt_id_idx" on "Item" item  (cost=0.29..342.46 rows=5589 width=100) (actual time=0.015..2.326 rows=4241 loops=1)
              Index Cond: (("workspaceId" = '10000000-0000-4000-8000-000000000001'::uuid) AND (status = 'OPEN'::"ItemStatus"))
              Buffers: shared hit=4272
        ->  Memoize  (cost=0.16..0.18 rows=1 width=48) (actual time=0.000..0.000 rows=0 loops=4241)
              Cache Key: item."claimedById"
              Cache Mode: logical
              Hits: 4240  Misses: 1  Evictions: 0  Overflows: 0  Memory Usage: 1kB
              ->  Index Scan using "User_pkey" on "User" claimant  (cost=0.15..0.17 rows=1 width=48) (actual time=0.001..0.001 rows=0 loops=1)
                    Index Cond: (id = item."claimedById")
Planning Time: 0.180 ms
Execution Time: 8.950 ms

Composite keyset plan:

Limit  (cost=0.45..8.18 rows=50 width=208) (actual time=0.036..0.178 rows=50 loops=1)
  Buffers: shared hit=52
  ->  Nested Loop Left Join  (cost=0.45..216.19 rows=1394 width=208) (actual time=0.035..0.172 rows=50 loops=1)
        Buffers: shared hit=52
        ->  Index Scan using "Item_workspaceId_status_createdAt_id_idx" on "Item" item  (cost=0.29..167.05 rows=1394 width=100) (actual time=0.019..0.074 rows=50 loops=1)
              Index Cond: (("workspaceId" = '10000000-0000-4000-8000-000000000001'::uuid) AND (status = 'OPEN'::"ItemStatus") AND (ROW("createdAt", id) < ROW('2024-07-01 04:41:02+00'::timestamp with time zone, '20000000-0000-4000-8000-000000000b1e'::uuid)))
              Buffers: shared hit=52
        ->  Memoize  (cost=0.16..0.19 rows=1 width=48) (actual time=0.000..0.000 rows=0 loops=50)
              Cache Key: item."claimedById"
              Cache Mode: logical
              Hits: 49  Misses: 1  Evictions: 0  Overflows: 0  Memory Usage: 1kB
              ->  Index Scan using "User_pkey" on "User" claimant  (cost=0.15..0.18 rows=1 width=48) (actual time=0.001..0.001 rows=0 loops=1)
                    Index Cond: (id = item."claimedById")
Planning Time: 0.173 ms
Execution Time: 0.219 ms
```

In this run, OFFSET advanced through 4,241 matching rows and touched 4,272
shared buffers before returning 50 rows, with 8.950 ms execution time.
The composite keyset query started directly at the `(createdAt, id)` boundary,
returned 50 rows, touched 52 shared buffers, and executed in 0.219 ms.

Absolute timings are environment-dependent; the important difference is
structural: OFFSET work grows with page depth, while keyset pagination seeks
to the composite boundary and keeps the work for the requested page bounded.

## R5 request-driven lazy claim expiration

Claim expiration uses **request-driven lazy cleanup**. PostgreSQL `claimedAt`
and the PostgreSQL database clock determine whether a claim is more than 30
minutes old. The stale comparison is strict: exactly 30:00 is still active; a
claim becomes stale only when

```sql
claimedAt < CURRENT_TIMESTAMP - INTERVAL '30 minutes'
```

For `claim`, `release`, and `resolve`, PostgreSQL `CURRENT_TIMESTAMP` is the
transaction-time clock, so the sweep and mutation predicates share the same
boundary. The next valid, authorized `GET queue`, `claim`, `release`, or
`resolve` interaction first performs an awaited, idempotent cleanup limited to
that workspace, then reads or mutates canonical queue state. There is no
background daemon, cron, scheduler, delayed queue, server timer, or Realtime
subscription.

An idle workspace can therefore retain physically stale `claimedById` and
`claimedAt` columns until its next authorized interaction. That stored stale
value does not grant mutation authority: release and resolve independently
require the current user to hold a still-active claim.

Resolve is evaluated against the current claim state when the request is
processed. If that user's stored claim is already stale, the sweep clears it
and resolve returns `409`, leaves the Item `OPEN`, and creates no
`NotificationDelivery`; the user must claim the Item again before resolving.

This implementation does not use per-lease fencing. If the same user reclaims
the Item before a delayed request from an older lease reaches the server, the
backend cannot distinguish that older request from an action against the new
lease. A system that required that distinction would add a claim generation or
token and require mutations to present it. The same limitation applies to a
delayed release.

While an active first page is visible, the client performs a canonical backend
read approximately every 10 seconds and also revalidates when the tab becomes
visible or the window regains focus. This is a UX refresh only, not a realtime
or exact-at-30:00 cleanup guarantee. Background polling pauses after a
continuation page has been loaded so it cannot replace or merge an in-progress
R4 traversal.

At materially higher traffic, a sweep on every queue interaction would become
wasteful; scheduled or coalesced cleanup would be a better design. If larger
workspace measurements also show the workspace-scoped stale predicate becoming
material, a targeted index should be evaluated from real query plans rather
than added preemptively at the current roughly 10,000-row scale.

With the development server running, verify the R5-specific guarantees with:

```powershell
npm run r5:verify
```

R5 verification intentionally targets stale/fresh cutoff, physical lazy
cleanup, late resolve, concurrent reclaim, and authorization isolation;
generic authentication and role cases remain covered by the existing
verifiers.

## Authorization assumption

Workspace memberships are intentionally static in this take-home; there is no
membership-management route. Writes repeat membership and role checks inside the
database mutation predicate, but route prechecks, queue reads, and housekeeping
are not designed to provide instantaneous revocation if an administrator changes
membership concurrently outside the application. A system with mutable
memberships would bind that authorization more tightly to the same transaction
or move the invariant into a dedicated policy/RLS layer.

## Verification

```powershell
npm run lint
npm run typecheck
npm run build
npm run session:verify
npm run r2:verify
npm run r1:verify
npm run release:verify
npm run r3:verify
npm run r4:verify
npm run r5:verify
npm run r4:explain
```
