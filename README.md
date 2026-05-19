# panacea-back

NestJS 11 + Drizzle ORM + PostgreSQL 16 API for Panacea. Git remote: `https://github.com/Didap/panacea-back.git`.

## Stack

- NestJS 11 (Express adapter), TypeScript 5.9 strict
- Drizzle ORM 0.45, `pg` driver, PostgreSQL 16 with row-level security
- Passport JWT (access 15m + refresh 7d, refresh hashes stored in DB)
- argon2 password hashing
- class-validator DTOs, global validation pipe
- nestjs-pino structured logging
- Resend + React Email (planned, not wired yet)
- Cloudflare R2 storage with SSE-KMS (planned, default driver is local filesystem)

## Run

```sh
docker compose up -d db
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm seed:dev        # optional, creates one patient + one doctor for dev
pnpm dev
```

Backend listens on `http://localhost:3000`. All routes are prefixed with `/api/v1`.

## Commands

| script | purpose |
| --- | --- |
| `pnpm dev` | watch mode with SWC |
| `pnpm build` | compile to `dist/` |
| `pnpm start` | run compiled bundle |
| `pnpm lint` | ESLint flat config |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Jest unit tests |
| `pnpm test:e2e` | Jest + supertest against a fresh test DB |
| `pnpm db:generate` | drizzle-kit generate from schema |
| `pnpm db:migrate` | apply pending migrations |
| `pnpm db:studio` | drizzle-kit studio |
| `pnpm seed:dev` | seed local dev data |
