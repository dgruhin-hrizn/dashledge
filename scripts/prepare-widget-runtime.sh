#!/bin/bash
set -euo pipefail
project="$(cd "$(dirname "$0")/.." && pwd)"
# Use an official standalone Node distribution so the installed app needs no
# developer tools or Homebrew dylibs. WIDGET_NODE selects an explicit binary.
candidates=()
if [[ -n "${WIDGET_NODE:-}" ]]; then
  candidates+=("$WIDGET_NODE")
else
  while IFS= read -r candidate; do candidates+=("$candidate"); done < <(which -a node)
fi
for candidate in "${candidates[@]}"; do
  node_path="$("$candidate" -p 'process.execPath')" || continue
  "$node_path" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || continue
  if otool -L "$node_path" | tail -n +2 | awk '$1 !~ "^(/System/Library/|/usr/lib/)" {external=1} END {exit external}'; then
    license="$(dirname "$(dirname "$node_path")")/LICENSE"
    [[ -f "$license" ]] || continue
    mkdir -p "$project/src-tauri/runtime"
    cp "$node_path" "$project/src-tauri/runtime/node"
    codesign --force --options runtime --entitlements "$project/src-tauri/WidgetRuntime.entitlements" --sign "${SIGN_IDENTITY:--}" "$project/src-tauri/runtime/node"
    "$project/src-tauri/runtime/node" -e "new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0))"
    cp "$license" "$project/src-tauri/runtime/Node.LICENSE"
    "$project/scripts/prepare-plan-sdks.sh"
    exit 0
  fi
done
echo 'Set WIDGET_NODE to the bin/node in an official macOS Node 24+ distribution with its LICENSE.' >&2
exit 1
