# CRM Task 1 report

## Status

Complete. Shared HTTP, authentication, and ingestion-token primitives were added and the three admin routes now use them. No enrollment routes or database migrations were added.

## Files

- Added `api/_lib/http.js` and `api/_lib/http.test.js`.
- Added `api/_lib/apiAuth.js` and `api/_lib/apiAuth.test.js`.
- Added `api/_lib/ingestTokens.js` and `api/_lib/ingestTokens.test.js`.
- Added `api/admin/admin-auth.test.js`.
- Refactored `api/admin/users.js`, `api/admin/intake-sheet.js`, and `api/admin/data-export.js`.

## TDD evidence

### RED

1. `npm test -- api/_lib/http.test.js api/_lib/apiAuth.test.js api/_lib/ingestTokens.test.js`
   - Failed as intended: each suite could not import its missing production helper (`./http.js`, `./apiAuth.js`, and `./ingestTokens.js`).
2. `npm test -- api/admin/admin-auth.test.js`
   - Failed as intended: all three regression tests reported `TypeError: createHandler is not a function`, establishing the required injection seam before endpoint refactoring.
3. `npm test -- api/_lib/apiAuth.test.js`
   - Failed as intended: explicit first-Manager bootstrap received `ApiError: Manager permission required.` before `requireAppUser` gained the narrowly-scoped bootstrap callback.

### GREEN

1. `npm test -- api/_lib/http.test.js api/_lib/apiAuth.test.js api/_lib/ingestTokens.test.js`
   - Passed: 14 tests after initial helpers; later 15 after the bootstrap regression.
2. `npm test -- api/_lib/http.test.js api/_lib/apiAuth.test.js api/_lib/ingestTokens.test.js api/admin/admin-auth.test.js`
   - Passed: 18 focused tests.
3. `npm test -- api/admin/admin-auth.test.js api/_lib/apiAuth.test.js`
   - Passed: 11 tests, including actual empty-`app_users` first-Manager bootstrap.
4. `npx eslint api/_lib/http.js api/_lib/http.test.js api/_lib/apiAuth.js api/_lib/apiAuth.test.js api/_lib/ingestTokens.js api/_lib/ingestTokens.test.js api/admin/users.js api/admin/intake-sheet.js api/admin/data-export.js api/admin/admin-auth.test.js`
   - Passed with no diagnostics.
5. `npm test`
   - Passed: 37 files, 413 tests.
6. `git diff --check`
   - Passed with no whitespace errors.

## Lint note

`npm run lint` was run as requested and remains non-zero due to 55 errors and 2 warnings in existing, unrelated `src/` files (predominantly `src/App.jsx`). The targeted lint command above is clean for every changed file.

## Security and compatibility review

- `requireAppUser` validates Supabase Auth first, then reads role and status from `app_users`; browser-provided role data is ignored.
- CAM access to a client requires a `client_assignments` row for the app user's `cam_profile_id`; Managers bypass that assignment lookup.
- `users.js` retains its explicit bootstrap path, and only when `app_users` is empty.
- `handleApiError` returns generic 500 messages in production and applies `Allow` headers from `requireMethod`.
- JSON request body reading is bounded to 64 KiB by default.
- Ingestion credentials are random, HMAC-SHA256 digested with a pepper, and compared only after strict hex validation using `timingSafeEqual`. Stored records contain a digest and device-token prefix only, never raw credentials.

## Concerns

- The repository-wide lint baseline is still unhealthy outside this task; it should be handled separately.
- Enrollment persistence/routes are intentionally not included because they require the later migration and endpoint work.

## Commit

`refactor: share secure API authentication`
