# Publishing the collector (for whoever owns the infrastructure)

The auto-collector is an agent that runs on each client's Windows VPS and uploads
the daily close by itself. The code ships in this repo; turning it on is four
steps, all done by whoever has access to the hosting and the CRM's environment
variables. Nothing here needs access to anyone else's repository.

Until a release is published the Auto Collection card shows **"Installer
unavailable"** — that is the expected state, not a bug.

## Step 1 — build the agent package

The package is a ~100 MB build artifact, so it is not committed. Produce it from
this repo's own CI:

**Actions → "Collector Windows" → Run workflow.** It has a manual trigger, so it
can be run on any branch. When it finishes, the run has an artifact named
`collector-agent-package-<number>`.

## Step 2 — stage the two files

Decide first where the files will be **served from** — any HTTPS folder works
(Supabase Storage public bucket, S3, a static host). That URL is baked into the
manifest, so it has to be known up front.

```bash
./scripts/prepare-release.sh https://<project>.supabase.co/storage/v1/object/public/collector
```

It pulls the newest successful build from this repository's Actions, and writes
`release-upload/`:

| File | What it is |
|---|---|
| `Vincere-AutoExport-Agent.zip` | the agent, the pairing window, and the install scripts |
| `release-manifest.json` | version and SHA-256 of the package |

and prints the two environment values from step 4.

Requires the GitHub CLI (`gh`) and Node. To pull from a different repository:
`COLLECTOR_REPO=<owner/repo> ./scripts/prepare-release.sh <base-url>`.

## Step 3 — upload both files

Upload **both** files to that exact folder. They must share one origin — the CRM
rejects a manifest whose artifacts are served from somewhere else. The folder has
to be publicly readable: the VPS machines download from it directly.

## Step 4 — set the environment variables

In the CRM project (Vercel → Settings → Environment Variables):

| Variable | Value |
|---|---|
| `AUTO_COLLECTION_RELEASE_MANIFEST_URL` | URL of `release-manifest.json` |
| `AUTO_COLLECTION_RELEASE_MANIFEST_SHA256` | the hash printed in step 2 |
| `AUTO_COLLECTION_MIN_AGENT_VERSION` | the version printed in step 2, e.g. `0.0.5830` |
| `INGEST_TOKEN_PEPPER` | a secret: `openssl rand -hex 32`. Generate it here and keep it here — it should never be sent over chat or committed. |

Redeploy, then confirm nothing is missing:

```bash
node scripts/verify-auto-collection-env.mjs
```

## Step 5 — confirm it worked

Open **Auto Collection** for any client. The card should stop saying "Installer
unavailable" and show a PowerShell command with a copy button.

To onboard a machine: on the client's VPS, open PowerShell **as administrator**
with NinjaTrader closed, paste that command, then paste the pairing code the card
generates.

## Re-publishing a newer build

Repeat steps 1–3, then update `AUTO_COLLECTION_RELEASE_MANIFEST_SHA256` to the
new value. The manifest is hash-pinned, so a changed manifest with a stale hash
is rejected — that is deliberate, and it is why the variable must move with it.

## Why the package is unsigned

Distribution does not depend on a code-signing certificate. Integrity is still
enforced: the manifest is pinned by SHA-256 through the environment variable, and
the package carries its own SHA-256 inside the manifest, so a tampered download
is rejected. What is absent is the Authenticode signature, so Windows warns when
a script downloaded from the internet is run — `collector/docs/installing.md`
covers `Unblock-File` for that.

## Known gap to close on staging

Automatic imports persist through a Postgres function that no test currently
executes — the database tests exist but are skipped unless
`AUTO_COLLECTION_TEST_DATABASE_URL` points at a real database. Once a staging
Supabase is available, set that variable and run the suite; the tests are
already written. Details in `docs/verification/auto-collection-crm.md`.

## What runs where

| Piece | Where it runs |
|---|---|
| CRM | Vercel + Supabase (already deployed) |
| Ingest API (`api/ingest/*`) | same Vercel project, no extra setup |
| Agent + pairing window | each client's Windows VPS |
| NinjaTrader AddOn | each client's VPS, inside NinjaTrader |

The AddOn is intentionally not in the package: CI only ever authors it against a
disposable payload, so the real one is deployed from a NinjaTrader-licensed
machine. `install-agent.ps1` warns and continues when it is absent, so the
service can be installed and paired before the AddOn is in place.
