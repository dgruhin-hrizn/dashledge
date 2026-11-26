#!/bin/bash
set -euo pipefail
project="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project"
if [[ $# -gt 1 || ("${1:-}" != "" && "${1:-}" != "--prepare-only") ]]; then
  echo 'Usage: package-mac.sh [--prepare-only]' >&2
  exit 2
fi
./scripts/prepare-widget-runtime.sh
cargo build --locked --release --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol
output_dir="${OUTPUT_DIR:-$project/dist}"
version=$(node -p "require('./package.json').version")
bundle="$output_dir/Edge Workbench.app"
contents="$bundle/Contents"
mkdir -p "$contents/MacOS" "$contents/Resources"
cp "${CARGO_TARGET_DIR:-$project/src-tauri/target}/release/edge-starter" "$contents/MacOS/EdgeWorkbench"
cp src-tauri/icons/icon.icns "$contents/Resources/Workbench.icns"
ditto widgets "$contents/Resources/widgets"
ditto src-tauri/runtime "$contents/Resources/runtime"
codesign --verify --strict "$contents/Resources/runtime/node"
cp src-tauri/Info.plist "$contents/Info.plist"
plist="$contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleName string Edge Workbench' "$plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleDisplayName string Edge Workbench' "$plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string EdgeWorkbench' "$plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string dev.edgeworkbench.desktop' "$plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundlePackageType string APPL' "$plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIconFile string Workbench' "$plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleVersion string 7' "$plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $version" "$plist"
/usr/libexec/PlistBuddy -c 'Add :NSHighResolutionCapable bool true' "$plist"
if [[ "${1:-}" == "--prepare-only" ]]; then
  echo "Prepared $bundle for signing."
else
  "$project/scripts/sign-mac.sh" "$bundle"
fi
