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

Set `DATABASE_URL` in `.env.local` before importing the server environment module or running database commands.

## Verification

```powershell
npm run lint
npm run typecheck
npm run build
```
