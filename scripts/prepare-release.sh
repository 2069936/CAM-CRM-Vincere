#!/usr/bin/env bash
# Produces the two files that have to be uploaded to publish the collector,
# ready in one folder, and prints the two environment values that go with them.
#
#   ./scripts/prepare-release.sh https://<project>.supabase.co/storage/v1/object/public/collector
#
# The agent package is a build artifact, not something kept in the repo — it is
# rebuilt on every CI run and is far too big for git. This pulls the newest one
# that passed, so the folder always matches a green build.
set -euo pipefail

BASE_URL="${1:-}"
RUN_ID="${2:-}"
# Whichever repository ran the collector workflow. Defaults to the one holding
# this checkout, so after the PR is merged this pulls from your own Actions runs
# and needs no access to anyone else's repository.
REPO="${COLLECTOR_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || echo '')}"
OUT_DIR="release-upload"

if [ -z "$BASE_URL" ]; then
  cat >&2 <<'USAGE'
Usage: ./scripts/prepare-release.sh <base-url> [run-id]

  base-url  the HTTPS folder the two files will be served from, e.g.
            https://abcdefgh.supabase.co/storage/v1/object/public/collector
  run-id    optional; defaults to the newest successful collector build

  COLLECTOR_REPO=<owner/repo> overrides which repository's build to pull from.

If no successful run exists yet, run the "Collector Windows" workflow once from
the Actions tab (it has a manual trigger), then run this again.
USAGE
  exit 1
fi

[ -n "$REPO" ] || { echo "Could not determine the repository. Set COLLECTOR_REPO=<owner/repo>." >&2; exit 1; }
echo "==> Repository: $REPO"

command -v gh >/dev/null || { echo "The GitHub CLI (gh) is required." >&2; exit 1; }

if [ -z "$RUN_ID" ]; then
  echo "==> Finding the newest successful collector build"
  RUN_ID=$(gh run list --repo "$REPO" --status success --limit 1 --json databaseId --jq '.[0].databaseId')
  [ -n "$RUN_ID" ] || { echo "No successful run found." >&2; exit 1; }
fi
echo "    Using run $RUN_ID"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "==> Downloading the agent package"
# The artifact is a zip containing our zip, so unwrap it into place.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
gh run download "$RUN_ID" --repo "$REPO" --pattern 'collector-agent-package-*' --dir "$TMP"
PACKAGE=$(find "$TMP" -name 'Vincere-AutoExport-Agent.zip' | head -1)
[ -n "$PACKAGE" ] || {
  echo "That run has no agent package. It predates the packaging step — re-run the collector workflow." >&2
  exit 1
}
cp "$PACKAGE" "$OUT_DIR/Vincere-AutoExport-Agent.zip"

echo "==> Building the manifest"
node "$(dirname "$0")/make-release-manifest.mjs" \
  --package "$OUT_DIR/Vincere-AutoExport-Agent.zip" \
  --base-url "$BASE_URL" \
  --version "0.0.${RUN_ID: -4}" \
  --out "$OUT_DIR/release-manifest.json"

echo ""
echo "Everything is in ./$OUT_DIR — upload BOTH files to $BASE_URL"
ls -la "$OUT_DIR"
