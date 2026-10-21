# CLAUDE.md — pos-backend

Guidance for Claude Code (and any AI agent) working in this repository.

## Golden Rule — ASK, DON'T ASSUME

**Never assume requirements.** Before writing any code:

- If the task is ambiguous, under-specified, or missing context (which store/caja is affected? which user role? what should happen on error? is this scoped to `MODO_CAJA_SIMPLE` or the normal flow too?), **stop and ask**.
- If there are multiple reasonable ways to implement something (e.g. new DB field vs. derived value, optimistic update vs. refetch, where a toggle should live), **present the options and ask which one the user wants** instead of silently picking one.
- It is always better to ask one extra question than to build the wrong thing. Do not treat "I can guess a reasonable default" as permission to skip asking — only proceed without asking when the request is fully unambiguous and scoped.
- This applies even to small-sounding tasks. A one-line request can hide a scoping decision (local DB only? also `schema.cloud.prisma`? also the sync service?).

## Required Workflow

For any non-trivial change, follow these steps in order:

1. **Analyze the problem.** Read the relevant routes/controllers/services/schema before proposing anything. Identify every place the change must reach (both Prisma schemas if the DB is touched, the sync service if a new synced field is added, the route's TypeScript interfaces, etc.).
2. **Write a detailed, step-by-step plan** describing exactly what will change and where (files, functions, schema fields, migrations).
3. **Ask for approval of the plan** before writing code — and per the Golden Rule, if the plan itself depends on an ambiguous decision, ask that question as part of this step rather than picking an option silently.
4. **Implement**, then **verify it actually works**: restart the dev server, check logs for errors, and exercise the affected endpoint(s) — don't just claim it's done because the code compiles.
5. **Get an independent review.** After the implementation is complete, have another agent (a fresh subagent, not the same context that wrote the code) review the diff against the original problem statement and the approved plan — not just "does this compile" but "does this actually solve what was asked, and does it match the plan." Give that reviewing agent the problem description and the plan as context so it can judge correctness, not just style.

Do not skip straight from "task received" to "code written."

## Tech Stack

- **Runtime/Framework:** Node.js, [Fastify 5](https://fastify.dev/) + TypeScript, ESM modules (`"type": "module"` — all local imports use `.js` extensions even in `.ts` files).
- **ORM:** [Prisma](https://www.prisma.io/) — **two schemas**:
  - `prisma/schema.prisma` → local SQLite (`DATABASE_URL`, file `prisma/dev.db`), the source of truth for offline/local operation.
  - `prisma/schema.cloud.prisma` → cloud PostgreSQL via Supabase (`DATABASE_CLOUD_URL` / `DIRECT_URL`). **Keep both schemas in sync manually** — a field added to one model must be added to the other too, unless it's local-only.
- **Cloud sync:** `src/services/sync.service.ts` — a `setInterval` loop (every 60s, see `src/index.ts`) that pulls from Supabase then pushes local changes (cajas → sesiones → vendedores → productos → stock → ventas, in that dependency order).
- **Auth:** Custom Bearer-token scheme (not JWT) — `src/plugins/auth.plugin.ts` (`authHook`) checks `Authorization: Bearer <API_SECRET>` against `.env`. Login (`POST /api/auth/login`) checks `ADMIN_PASSWORD` / `EMPLEADO_PASSWORD` and returns a role. All `/api/*` routes except `/api/auth/*` require this header.
- **Electronic invoicing:** `src/services/afip.service.ts` via `@afipsdk/afip.js` — ARCA/AFIP integration (Argentina).
- **Structure:** `src/routes/*.routes.ts` (Fastify route registration) → `src/controllers/*.controller.ts` (handlers, Prisma calls) → `src/services/*` (cross-cutting logic: sync, AFIP) → `src/db/` (`prisma.ts`, `supabase.ts` clients).
- **Feature flags via env vars:** `MODO_CAJA_SIMPLE=true` + `CAJA_ID=<uuid>` switches the system into single-cashier-per-session mode (no vendedor selection; ventas scoped to `SesionCaja`). Read these as `process.env.*` directly in controllers/routes, not stored in the DB.
- **Dev server:** `npm run dev` (nodemon + ts-node). **Build:** `npm run build` (tsc). Cloud build variant: `npm run build:cloud` (regenerates the Prisma client from `schema.cloud.prisma` first).

## Critical Security Rule

- `pos-backend/.env` is in `.gitignore` and **must never be committed**. It holds `API_SECRET`, `ADMIN_PASSWORD`, `EMPLEADO_PASSWORD`, `DATABASE_CLOUD_URL`, `DIRECT_URL`, `SUPABASE_KEY`.
- Before any `git add`/`git commit` that could touch `.env`, double-check `git status` first.

## Notes on the Sync/Schema Pattern

- Any new field on a model that participates in cloud sync needs: (1) `schema.prisma`, (2) `schema.cloud.prisma`, (3) `prisma db push` locally, (4) a check of whether `sync.service.ts` needs to carry the new field across.
- `dist/` is build output and is gitignored — do not worry about deleted/stale files there showing up in `git status`.
