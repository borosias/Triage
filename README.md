# Flamingo

Flamingo Home Assignment implementation with atomic item claiming and sealed
workspace reads and claim writes.

## Requirements

- Node.js 20.19.0 or newer
- npm

## Local setup

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Configure the database URLs and session secret in `.env.local`:

- `DATABASE_URL`: the Supabase transaction pooler URL used by the serverless application runtime.
- `DIRECT_URL`: the Supabase direct database URL used by Prisma migrations. If the direct IPv6 endpoint is unavailable locally, use the Supabase session pooler URL instead.
- `SESSION_SECRET`: a private random value of at least 32 characters used to sign the local login cookie.

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
recreating four users, two workspaces, six memberships, and 10,000 items. It
does not remove Prisma migration metadata, schemas, or extensions. The seed uses
`DIRECT_URL` and is safe to repeat: every run recreates the same deterministic
fixtures instead of appending duplicates.

## Local login

Open the application and choose Alice, Bob, Carol, or Dana from the dropdown.
The users come from the seeded `User` table. The selection creates an eight-hour
signed, HttpOnly session cookie; use **Log out** to clear it. This is the
assignment's intentionally fake login and does not implement real authentication.

With the development server running on port 3000, verify the session flow with:

```powershell
npm run session:verify
```

## Workspace-scoped queue reads and claims

Authenticated users can list only workspaces where they have a database-backed
membership. Selecting one loads up to 50 newest `OPEN` items from that workspace,
including both claimed and unclaimed items. `OWNER`, `MEMBER`, and `VIEWER` can
all read. A request for a workspace without membership returns `404`, and every
item query includes the requested workspace ID in its database predicate.

`OWNER` and `MEMBER` may claim an unclaimed `OPEN` item. `VIEWER` cannot claim,
and item IDs cannot cross workspace boundaries. Claiming uses one conditional
PostgreSQL `UPDATE ... RETURNING`; the item, workspace, state, unclaimed check,
membership, and write-capable role are all part of that mutation predicate.

The queue waits for the claim response before changing the claimant. A `200`
response displays the confirmed claimant, while a concurrent `409` immediately
reconciles the row to the canonical claimant returned by the server.

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

Release, resolve, notifications, pagination, and claim expiry are not included
in this slice.

## Verification

```powershell
npm run lint
npm run typecheck
npm run build
```
