# Publishing the collector so the install button turns on

Until a release is published, the Auto Collection card shows **"Installer
unavailable"**. Publishing is two uploads and two environment variables.

## Why the files aren't in the repo

The agent package is a ~100 MB build artifact rebuilt on every CI run, so it
lives in the build, not in git. `scripts/prepare-release.sh` pulls the newest one
that passed and writes both files into a folder ready to upload — so the folder
always matches a green build rather than a stale copy someone committed.

## Step 1 — produce the two files

```bash
./scripts/prepare-release.sh https://<project>.supabase.co/storage/v1/object/public/collector
```

The URL is the folder the files will be **served from** — pass it up front,
because it is baked into the manifest.

This writes `release-upload/`:

| File | What it is |
|---|---|
| `Vincere-AutoExport-Agent.zip` | the agent, setup window and install scripts |
| `release-manifest.json` | version + SHA-256 of the package |

and prints the two environment values.

## Step 2 — upload both files

Upload the **two files together** to that exact URL. In Supabase: Storage → a
public bucket (e.g. `collector`) → upload both.

They must share one folder: the CRM rejects a manifest whose artifacts sit on a
different origin.

## Step 3 — set the environment variables

In the CRM's Vercel project, Settings → Environment Variables:

| Variable | Value |
|---|---|
| `AUTO_COLLECTION_RELEASE_MANIFEST_URL` | URL of `release-manifest.json` |
| `AUTO_COLLECTION_RELEASE_MANIFEST_SHA256` | the hash the script printed |

Two more are required for auto-collection generally, if they aren't set yet:

| Variable | Value |
|---|---|
| `INGEST_TOKEN_PEPPER` | a secret, e.g. `openssl rand -hex 32`. Generate it directly in Vercel — it should not travel through chat or the repo. |
| `AUTO_COLLECTION_MIN_AGENT_VERSION` | the version the script printed, e.g. `0.0.1234` |

Redeploy so they take effect, then check everything is present:

```bash
node scripts/verify-auto-collection-env.mjs
```

## Step 4 — confirm

Open **Auto Collection** for any client. The card should stop saying "Installer
unavailable" and show the PowerShell command with a copy button.

## Re-publishing a new build

Run step 1 again and re-upload both files. The manifest is pinned by hash, so
`AUTO_COLLECTION_RELEASE_MANIFEST_SHA256` **must** be updated to the new value —
otherwise the CRM correctly rejects the changed manifest.

## About signing

The published package is unsigned, which is why no certificate is needed. The
manifest and every artifact are still pinned by SHA-256, so a tampered download
is rejected. Windows will warn when a script from the internet is run; the
install doc covers `Unblock-File`. If a code-signing certificate is bought later,
publish `Vincere-AutoExport-Setup.exe` with a `signingThumbprint` in the manifest
and the CRM will prefer nothing — it takes the package first — so drop the zip
from the manifest to switch over.
