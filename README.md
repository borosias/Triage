# Flamingo

Flamingo Home Assignment implementation with atomic item claiming, release,
and resolve, plus sealed workspace reads and writes and durable notification
delivery records.

## Requirements

- Node.js 20.19.0 or newer
- npm

## Local setup

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
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
```

`npm run seed` is a destructive development-only operation. It resets only the
`Item`, `WorkspaceMembership`, `Workspace`, and `User` application tables before
recreating four users, two workspaces, six memberships, and 10,000 items.
Deleting Items also removes their associated `NotificationDelivery` rows through
the committed foreign key. The seed does not remove Prisma migration metadata,
schemas, or extensions. It uses `DIRECT_URL` and is safe to repeat: every run
recreates the same deterministic fixtures instead of appending duplicates.

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
membership. Selecting one loads up to 50 newest `OPEN` items from that workspace,
including both claimed and unclaimed items. `OWNER`, `MEMBER`, and `VIEWER` can
all read. A request for a workspace without membership returns `404`, and every
item query includes the requested workspace ID in its database predicate.

`OWNER` and `MEMBER` may claim an unclaimed `OPEN` item. `VIEWER` cannot claim,
and item IDs cannot cross workspace boundaries. Claiming uses one conditional
PostgreSQL `UPDATE ... RETURNING`; the item, workspace, state, unclaimed check,
membership, and write-capable role are all part of that mutation predicate.

The same write-capable roles may release only their own claim on an `OPEN` item.
Release clears both claim fields in one conditional `UPDATE ... RETURNING`, with
item identity, workspace boundary, open state, claim ownership, membership, and
role enforced by that statement.

They may also resolve only their own claim on an `OPEN` item. Resolve uses a
short Prisma interactive transaction: one conditional PostgreSQL mutation
enforces Item identity, workspace boundary, state, claimant, membership, and
role, then the same transaction client inserts one `PENDING`
`NotificationDelivery`. If the insert fails, the Item mutation rolls back.

The queue waits for claim, release, and resolve responses before changing a row.
A `200` response displays the confirmed state, while a `409` immediately
reconciles the row to the canonical item returned by the server. Successful
resolve removes the Item from the OPEN queue and reports `Resolved. Notification
queued.` without waiting for notification delivery.

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
then returns without calling or waiting for `notify()`. A Supabase Database
Webhook starts a separate serverless invocation. The internal worker reloads
canonical delivery data by delivery ID, atomically acquires only
`PENDING -> PROCESSING`, and makes one attempt. `notify()` waits about one second
and fails on roughly 20% of calls. Success stores `SENT`; a normal notify failure
stores `FAILED` with a short non-sensitive error value.

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
migration. Local verification does not require a configured remote webhook; it
sends a representative Supabase INSERT payload directly to the internal worker.

With the development server running and the same webhook secret available to
both server and verifier, run:

```powershell
npm run r3:verify
```

The verifier uses real signed sessions and direct PostgreSQL assertions. It
covers resolve roles and isolation, the Item-plus-delivery transaction result,
secret and payload validation, one CAS acquisition, terminal `SENT | FAILED`,
duplicate no-op behavior, safe failure storage, and fixture restoration.

Pagination and claim expiry are not included in this slice.

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
```
