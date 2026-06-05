# Backend health pass — 2026-06-05

The repo did not build, typecheck, or run its e2e suite on a fresh `git clone && npm install`.
Several pre-existing problems had accumulated because the suite had never been run green against
the pinned dependency versions. This pass makes `npm install`, lint, typecheck, build, and e2e all
green from a clean checkout. No feature behaviour changes.

## What was broken and how it was fixed

1. **`npm install` failed (ERESOLVE).** `@nestjs/schedule@4.1.2` declares peer
   `@nestjs/common@^8 || ^9 || ^10`, incompatible with the repo's NestJS 11. Bumped to
   `@nestjs/schedule@^6.1.3` (peer `^10 || ^11`). Clean install now succeeds without
   `--legacy-peer-deps`; `package-lock.json` regenerated.

2. **Two type errors blocked all compilation.**
   - `database/schema/users.ts`: a partial-index `.where()` was passed a template string;
     drizzle requires an `SQL` object. Now `where(sql\`${t.deletedAt} IS NULL\`)`.
   - `modules/auth/auth.service.ts`: `signAsync(..., { expiresIn })` failed because the env-derived
     `string` is not assignable to `@nestjs/jwt`'s `expiresIn` (`ms.StringValue | number`). The env
     schema already validates the duration format, so we cast to `JwtSignOptions['expiresIn']`.

3. **e2e could not boot the app (ESM/CJS).** `file-type@21` is ESM-only; the backend is CommonJS
   under ts-jest, so `import { fileTypeFromBuffer } from 'file-type'` could not be required.
   `health-documents.service.ts` now loads it via a dynamic import behind a `new Function` indirection
   (so `module: commonjs` does not down-level the `import()` to `require()`).

4. **Circular dependency in `StorageModule`.** `storage.module.ts` imported `StorageService`, and
   `storage.service.ts` imported `STORAGE_DRIVER_TOKEN` back from `storage.module.ts`, leaving the
   token `undefined` when the `@Inject` decorator ran. The current `@nestjs/core` rejects this.
   Moved `STORAGE_DRIVER_TOKEN` into the leaf `storage.driver.ts`; the module-service import is now
   one-directional.

5. **Error contract not applied under tests.** `AllExceptionsFilter` was registered only in
   `main.ts` via `useGlobalFilters`, so e2e apps (built from `AppModule`) returned no `code` body and
   the OTP-attempts test could not assert error codes. Registered the filter as an `APP_FILTER`
   provider in `AppModule` (DI-injected `Logger`) and removed the duplicate from `main.ts`. Prod and
   tests now share one error contract.

6. **Lint was red across the repo.** Fixed redundant type assertions (`auth.service`,
   `delegations.service`), two `require-await` notification drivers (now return
   `Promise.resolve` / `Promise.reject`), one `no-useless-escape`, typed an audit catch param as
   `unknown`, and disabled `no-implied-eval` on the documented `new Function` line. Added eslint
   overrides: relax `no-unsafe-*` for `test/**` (supertest's API is `any`), and `disableTypeChecked`
   for root config files outside `tsconfig` include.

## Verification

Fresh checkout: `npm install` (no flags), `npm run lint`, `npm run typecheck`, `npm run build` all
pass; `docker compose up -d` then `npm run db:migrate` then `npm run test:e2e` → 2 suites, 3 tests
green.
