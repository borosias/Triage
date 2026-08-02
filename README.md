# Flamingo

Minimal Epic 0 foundation for the Flamingo Home Assignment.

## Requirements

- Node.js 20.19.0 or newer
- npm

## Local setup

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Configure both URLs in `.env.local`:

- `DATABASE_URL`: the Supabase transaction pooler URL used by the serverless application runtime.
- `DIRECT_URL`: the Supabase direct database URL used by Prisma migrations. If the direct IPv6 endpoint is unavailable locally, use the Supabase session pooler URL instead.

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

## Verification

```powershell
npm run lint
npm run typecheck
npm run build
```
