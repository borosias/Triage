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

## Verification

```powershell
npm run lint
npm run typecheck
npm run build
```
