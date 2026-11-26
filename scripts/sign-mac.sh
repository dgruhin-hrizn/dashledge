#!/bin/bash
# Sign a prepared Dashledge bundle using the Hrizn identity also used by Ember.
set -euo pipefail
bundle="${1:?Pass the path to Dashledge.app}"
project="$(cd "$(dirname "$0")/.." && pwd)"
contents="$bundle/Contents"
plist="$contents/Info.plist"
[[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$plist")" == dev.edgeworkbench.desktop ]] || { echo 'Expected a Dashledge app bundle.' >&2; exit 1; }
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
if [[ -d "$contents/Resources/runtime/plan-sdks/python" ]]; then
  while IFS= read -r -d '' binary; do
    /usr/bin/codesign --force --options runtime "$timestamp" --sign "$identity" "$binary"
  done < <(find "$contents/Resources/runtime/plan-sdks/python" -type f \( -name '*.so' -o -name '*.dylib' -o -name python3 \) -print0)
fi
/usr/bin/codesign --force --options runtime "$timestamp" --entitlements "$project/src-tauri/WidgetRuntime.entitlements" --sign "$identity" "$contents/Resources/runtime/node"
/usr/bin/codesign --force --options runtime "$timestamp" --entitlements "$project/src-tauri/Entitlements.plist" --sign "$identity" "$bundle"
/usr/bin/codesign --verify --strict --deep "$bundle"
# Check the embedded entitlement by its literal key (the dots are part of its name).
/usr/bin/codesign --display --entitlements - --xml "$bundle" 2>/dev/null |
  /usr/bin/xmllint --xpath 'boolean(/plist/dict/key[.="com.apple.security.personal-information.calendars"]/following-sibling::*[1][self::true])' - |
  /usr/bin/grep -qx true || { echo 'Signed Dashledge is missing Calendar access.' >&2; exit 1; }
output_dir="$(dirname "$bundle")"
archive="$output_dir/Dashledge-macOS-$(uname -m).zip"
temp_dir="$(mktemp -d "$output_dir/.archive.XXXXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT
ditto -c -k --sequesterRsrc --keepParent "$bundle" "$temp_dir/archive.zip"
mv -f "$temp_dir/archive.zip" "$archive"
/usr/bin/codesign --display --verbose=2 "$bundle" 2>&1 | awk '/^Authority=|^TeamIdentifier=/'
echo "$archive"
if [[ "$identity" != '-' && "${2:-}" != "--archive-only" ]]; then
  /usr/bin/swift "$project/scripts/install-mac.swift" "$bundle"
fi
