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
build_number=$(git rev-list --count HEAD)
bundle="$output_dir/Dashledge.app"
contents="$bundle/Contents"
mkdir -p "$contents/MacOS" "$contents/Resources" "$contents/Helpers"
xcrun swiftc -O -target "$(uname -m)-apple-macos11.0" scripts/install-mac.swift -o "$contents/Helpers/DashledgeUpdater"
cp "${CARGO_TARGET_DIR:-$project/src-tauri/target}/release/edge-starter" "$contents/MacOS/Dashledge"
# Personal builds can carry a user-supplied default card. Regular releases have no card artwork.
if [[ -n "${RUNDMD_IMAGE:-}" ]]; then
  cp "$RUNDMD_IMAGE" "$contents/Resources/rundmd-default.imgc"
elif [[ -f "$contents/Resources/rundmd-default.imgc" ]]; then
  rm "$contents/Resources/rundmd-default.imgc"
fi
cp src-tauri/icons/icon.icns "$contents/Resources/Dashledge.icns"
cp LICENSE "$contents/Resources/Edge-Starter-LICENSE.txt"
ditto widgets "$contents/Resources/widgets"
ditto src-tauri/runtime "$contents/Resources/runtime"
codesign --verify --strict "$contents/Resources/runtime/node"
cp src-tauri/Info.plist "$contents/Info.plist"
plist="$contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleName string Dashledge' "$plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleDisplayName string Dashledge' "$plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string Dashledge' "$plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string dev.edgeworkbench.desktop' "$plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundlePackageType string APPL' "$plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIconFile string Dashledge' "$plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleVersion string $build_number" "$plist"
/usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $version" "$plist"
/usr/libexec/PlistBuddy -c 'Add :NSHighResolutionCapable bool true' "$plist"
if [[ "${1:-}" == "--prepare-only" ]]; then
  echo "Prepared $bundle for signing."
else
  "$project/scripts/sign-mac.sh" "$bundle"
fi
