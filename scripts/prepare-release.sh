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
  # PINNED TO THE COLLECTOR WORKFLOW ON MAIN, DELIBERATELY.
  #
  # Unpinned, `gh run list --status success --limit 1` returns the newest
  # successful run of ANY workflow on ANY branch, including a pull request from
  # anyone. It would happily hand a CRM build, or a stranger's branch build, to
  # a script whose output is installed as SYSTEM on machines holding live client
  # prop-firm accounts.
  echo "==> Finding the newest successful collector build on main"
  RUN_ID=$(gh run list --repo "$REPO" --workflow collector-windows.yml --branch main \
    --status success --limit 1 --json databaseId --jq '.[0].databaseId')
  [ -n "$RUN_ID" ] || { echo "No successful collector-windows.yml run on main." >&2; exit 1; }
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

# THE VERSION IS THE AGENT'S OWN, NOT THE RUN ID.
#
# This used to stamp "0.0.<last 4 of the run id>", and make-release-manifest.mjs
# writes that same string into BOTH `version` and `minimumAgentVersion`. Both
# checks that would tell a machine to update compare against it numerically:
# collectorFlags.js agentOutOfDate against `version`, and heartbeat.js
# requiresCollectorUpdate against `minimumAgentVersion`. Against 0.0.5830 a
# machine on 1.0.3 compares GREATER, so both silently answer "no update needed".
#
# Measured: requiresCollectorUpdate('1.0.3', '0.0.5830') is false;
#           requiresCollectorUpdate('1.0.3', '1.0.9')    is true.
#
# That is why six releases shipped and 28 of about 30 machines stayed on 1.0.3.
# The notice could not fire. Read the version the agent actually declares.
AGENT_CSPROJ="$(dirname "$0")/../collector/src/Vincere.AutoExport.Agent.UI/Vincere.AutoExport.Agent.UI.csproj"
VERSION="${AGENT_VERSION:-$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' "$AGENT_CSPROJ" | head -1)}"
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "Could not read a version like 1.2.3 from $AGENT_CSPROJ (got '$VERSION'). Set AGENT_VERSION=." >&2; exit 1 ;;
esac
echo "==> Building the manifest for agent $VERSION"
node "$(dirname "$0")/make-release-manifest.mjs" \
  --package "$OUT_DIR/Vincere-AutoExport-Agent.zip" \
  --base-url "$BASE_URL" \
  --version "$VERSION" \
  --out "$OUT_DIR/release-manifest.json"

echo ""
echo "Everything is in ./$OUT_DIR — upload BOTH files to $BASE_URL"
ls -la "$OUT_DIR"
