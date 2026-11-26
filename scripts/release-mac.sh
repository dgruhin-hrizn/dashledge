#!/bin/bash
# Build and publish a stable GitHub Release from a fresh checkout of the merged source.
set -euo pipefail
repo=dgruhin-hrizn/dashledge
root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node "$root/scripts/release-version.mjs")"
tag="v$version"
[[ "$(uname -sm)" == "Darwin arm64" ]] || { echo 'Use an Apple Silicon Mac.' >&2; exit 1; }
gh auth status -h github.com >/dev/null
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git clone --quiet --single-branch --branch main "https://github.com/$repo.git" "$work/source"
cd "$work/source"
sha="$(git rev-parse HEAD)"
[[ "$(node scripts/release-version.mjs)" == "$version" ]] || { echo 'Merge the version bump into main first.' >&2; exit 1; }
asset="Dashledge-$tag-macOS-arm64.zip"
remote_tag="$(git ls-remote --tags origin "refs/tags/$tag" "refs/tags/$tag^{}" | tail -1 | cut -f1)"
[[ -z "$remote_tag" || "$remote_tag" == "$sha" ]] || { echo "$tag already belongs to another revision." >&2; exit 1; }
if [[ "$(gh release view "$tag" -R "$repo" --json isDraft --jq .isDraft 2>/dev/null || true)" == false ]]; then
  gh release view "$tag" -R "$repo" --json url --jq .url
  exit 0
fi
latest="$(gh release list -R "$repo" --limit 100 --json tagName,isLatest --jq '.[]|select(.isLatest)|.tagName')"
if [[ -n "$latest" ]]; then
  node -e 'const parts=v=>v.replace(/^v/,"").split(".").map(Number);const a=parts(process.argv[1]),b=parts(process.argv[2]);const i=a.findIndex((v,i)=>v!==b[i]);if(i<0||!(a[i]>b[i]))throw Error("Latest release is "+process.argv[2])' "$version" "$latest"
fi
security find-identity -v -p codesigning | grep -F 'Developer ID Application: HORIZN INC (K5K2SPTZVV)' >/dev/null || { echo 'Open a Mac Terminal with the HORIZN INC Developer ID available.' >&2; exit 1; }
profile="${DASHLEDGE_NOTARY_PROFILE:-ember-notary}"
xcrun notarytool history --keychain-profile "$profile" --output-format json >/dev/null
scripts/release-runner.sh "$sha"
unset RUNDMD_IMAGE SIGN_IDENTITY EMBER_SIGN_IDENTITY
export OUTPUT_DIR="$work/public"
scripts/prepare-widget-runtime.sh
npm test
scripts/package-mac.sh --prepare-only
app="$OUTPUT_DIR/Dashledge.app"
[[ ! -e "$app/Contents/Resources/rundmd-default.imgc" ]]
scripts/sign-mac.sh "$app" --archive-only
archive="$OUTPUT_DIR/Dashledge-macOS-arm64.zip"
xcrun notarytool submit "$archive" --keychain-profile "$profile" --wait --output-format json > "$work/notary.json"
node -e 'if(require(process.argv[1]).status!=="Accepted")throw Error("Apple did not accept the archive")' "$work/notary.json"
xcrun stapler staple "$app"
xcrun stapler validate "$app"
codesign --verify --deep --strict "$app"
ditto -c -k --sequesterRsrc --keepParent "$app" "$work/$asset"
(cd "$work" && shasum -a 256 "$asset" > "$asset.sha256")
[[ "$(git ls-remote origin refs/heads/main | cut -f1)" == "$sha" ]] || { echo 'main advanced. Restart the release.' >&2; exit 1; }
if ! gh release view "$tag" -R "$repo" >/dev/null 2>&1; then
  gh release create "$tag" -R "$repo" --target "$sha" --title "Dashledge $version" --generate-notes --draft
fi
[[ "$(gh release view "$tag" -R "$repo" --json isDraft,targetCommitish --jq '.isDraft and (.targetCommitish == "'"$sha"'")')" == true ]]
gh release upload "$tag" -R "$repo" "$work/$asset" "$work/$asset.sha256" --clobber
gh release edit "$tag" -R "$repo" --draft=false --latest
[[ "$(gh api "repos/$repo/releases/latest" --jq .tag_name)" == "$tag" ]]
gh release view "$tag" -R "$repo" --json url --jq .url
