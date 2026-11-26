#!/bin/bash
# Sign a prepared Workbench bundle using the Hrizn identity also used by Ember.
set -euo pipefail
bundle="${1:?Pass the path to Edge Workbench.app}"
project="$(cd "$(dirname "$0")/.." && pwd)"
contents="$bundle/Contents"
plist="$contents/Info.plist"
[[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$plist")" == dev.edgeworkbench.desktop ]] || { echo 'Expected an Edge Workbench app bundle.' >&2; exit 1; }
identity="${SIGN_IDENTITY:-${EMBER_SIGN_IDENTITY:-}}"
if [[ -z "$identity" ]]; then
  identity="$(/usr/bin/security find-identity -v -p codesigning | awk '/"Developer ID Application: HORIZN INC \(K5K2SPTZVV\)"/ && !found {print $2; found=1}')"
  if [[ -z "$identity" ]]; then
    echo 'The HORIZN INC Developer ID Application identity (team K5K2SPTZVV) is unavailable in this Keychain session.' >&2
    exit 1
  fi
fi
timestamp=--timestamp
if [[ "$identity" == '-' ]]; then timestamp=--timestamp=none; fi
/usr/bin/codesign --force --options runtime "$timestamp" --entitlements "$project/src-tauri/WidgetRuntime.entitlements" --sign "$identity" "$contents/Resources/runtime/node"
/usr/bin/codesign --force --options runtime "$timestamp" --entitlements "$project/src-tauri/Entitlements.plist" --sign "$identity" "$bundle"
/usr/bin/codesign --verify --strict --deep "$bundle"
output_dir="$(dirname "$bundle")"
archive="$output_dir/Edge-Workbench-macOS-$(uname -m).zip"
temp_dir="$(mktemp -d "$output_dir/.archive.XXXXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT
ditto -c -k --sequesterRsrc --keepParent "$bundle" "$temp_dir/archive.zip"
mv -f "$temp_dir/archive.zip" "$archive"
/usr/bin/codesign --display --verbose=2 "$bundle" 2>&1 | awk '/^Authority=|^TeamIdentifier=/'
echo "$archive"
if [[ "$identity" != '-' ]]; then
  /usr/bin/swift "$project/scripts/install-mac.swift" "$bundle"
fi
