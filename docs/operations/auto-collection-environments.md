# Auto-collection environment readiness

Run the readiness checker before deploying collector migrations, API routes, or
a signed Windows release. It reads staging and production metadata locally,
performs read-only manifest requests, and prints setting names and pass/fail
codes only. It never prints configuration values.

## Separation requirements

- Staging and production use different Supabase projects and different
  `INGEST_TOKEN_PEPPER` values.
- Service-role keys, peppers, enrollment material, device credentials, and
  signing secrets remain server-only. No secret uses a `VITE_` prefix.
- `ninjatrader-imports` is a private Storage bucket in each project.
- Production Vercel deployment access and the `collector-production` GitHub
  environment are restricted to approved release operators.
- The self-hosted `ninjatrader8` runner is company controlled, patched, and has
  proprietary NinjaTrader assemblies outside the checkout.
- The Windows signing certificate is hardware-backed or stored only in the
  protected GitHub environment. Its password and timestamp service are never
  added to repository files.

## Read-only check

Export each environment to a temporary dotenv file outside the repository. The
files must contain the variables listed in `.env.example`; do not commit them.
Then run:

```bash
npm run collector:verify-env -- \
  --staging-env /secure/temp/staging.env \
  --production-env /secure/temp/production.env
```

The checker validates:

- required Supabase browser/server settings and matching public configuration;
- distinct project URLs and HMAC peppers;
- non-placeholder secrets and bounded numeric settings;
- minimum agent version and the supported schema version;
- a no-redirect HTTPS release-manifest URL and pinned raw-byte SHA-256;
- the complete release manifest, signer thumbprint, artifact hashes/sizes, and
  exact same-origin `Vincere-AutoExport-Setup.exe` entry; and
- agreement between the server minimum version and release manifest.

Exit code `0` means ready, `1` means one or more named checks failed, and `2`
means the checker could not safely read or evaluate the inputs. Remove the
temporary files after recording the value-free result.

## Database and storage order

1. Apply `supabase/step_22_ingest_devices.sql`.
2. Apply `supabase/step_28_auto_collection.sql`.
3. Apply `supabase/step_29_auto_collection_reprocess.sql`.
4. Re-run steps 28 and 29 on disposable staging to prove idempotence.
5. Run the catalog checks in `docs/verification/auto-collection-schema.md`.
6. Confirm `ninjatrader-imports` is private before accepting any snapshot.

Application rollback is non-destructive: remove the two release-manifest
settings to stop new installations, revoke affected devices if necessary, and
deploy the previous application. Retain ingest batches, raw objects, lineage,
and audit records.
