#!/usr/bin/env bash
# Adds the NinjaTrader-built runtime payload to the portable CI package.
set -euo pipefail

BASE_PACKAGE="${1:-}"
ADDON_DIR="${2:-}"
OUTPUT_PACKAGE="${3:-}"

if [ -z "$BASE_PACKAGE" ] || [ -z "$ADDON_DIR" ] || [ -z "$OUTPUT_PACKAGE" ]; then
  echo "Usage: $0 <base-agent.zip> <addon-directory> <output-agent.zip>" >&2
  exit 1
fi

[ -f "$BASE_PACKAGE" ] || { echo "Base agent package not found: $BASE_PACKAGE" >&2; exit 1; }
[ -d "$ADDON_DIR" ] || { echo "AddOn directory not found: $ADDON_DIR" >&2; exit 1; }

BASE_PACKAGE="$(cd "$(dirname "$BASE_PACKAGE")" && pwd -P)/$(basename "$BASE_PACKAGE")"
ADDON_DIR="$(cd "$ADDON_DIR" && pwd -P)"
mkdir -p "$(dirname "$OUTPUT_PACKAGE")"
OUTPUT_PACKAGE="$(cd "$(dirname "$OUTPUT_PACKAGE")" && pwd -P)/$(basename "$OUTPUT_PACKAGE")"

REQUIRED_DLLS=(
  Vincere.AutoExport.NinjaTrader.dll
  Vincere.AutoExport.NinjaTrader.Core.dll
  Vincere.AutoExport.Contracts.dll
  Newtonsoft.Json.dll
)

for name in "${REQUIRED_DLLS[@]}"; do
  path="$ADDON_DIR/$name"
  [ -s "$path" ] || { echo "Required AddOn DLL is missing or empty: $path" >&2; exit 1; }
done

WORK_DIR=$(mktemp -d)
TEMP_OUTPUT="${OUTPUT_PACKAGE}.tmp.$$"
cleanup() {
  rm -rf "$WORK_DIR"
  rm -f "$TEMP_OUTPUT"
}
trap cleanup EXIT

unzip -q "$BASE_PACKAGE" -d "$WORK_DIR/package"
[ -f "$WORK_DIR/package/Agent/Vincere.AutoExport.Agent.exe" ] || {
  echo 'Base package is missing Agent/Vincere.AutoExport.Agent.exe' >&2
  exit 1
}
[ -f "$WORK_DIR/package/Setup/Vincere.AutoExport.Agent.UI.exe" ] || {
  echo 'Base package is missing Setup/Vincere.AutoExport.Agent.UI.exe' >&2
  exit 1
}

rm -rf "$WORK_DIR/package/AddOn"
mkdir -p "$WORK_DIR/package/AddOn"
for name in "${REQUIRED_DLLS[@]}"; do
  cp "$ADDON_DIR/$name" "$WORK_DIR/package/AddOn/$name"
done

(
  cd "$WORK_DIR/package"
  zip -q -r "$TEMP_OUTPUT" .
)
mv -f "$TEMP_OUTPUT" "$OUTPUT_PACKAGE"

echo "Complete collector package: $OUTPUT_PACKAGE"
