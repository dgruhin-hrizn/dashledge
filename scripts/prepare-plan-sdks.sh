#!/bin/bash
# Build-time only. End users run the SDKs and interpreter shipped inside Dashledge.
set -euo pipefail
project="$(cd "$(dirname "$0")/.." && pwd)"
runtime="$project/src-tauri/runtime"
dest="$runtime/plan-sdks"
version="claude-0.3.296_codex-0.172.0_py-3.14.9_$(uname -m)"
if [[ -f "$dest/version" && "$(cat "$dest/version")" == "$version" && -x "$dest/python/bin/python3" && -f "$dest/claude/sdk.mjs" ]]; then exit 0; fi
stage="$(mktemp -d "$runtime/.plan-sdks.XXXXXXXX")"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/claude" "$stage/python/bin" "$stage/python/lib"
archive="${PLAN_CLAUDE_TARBALL:-$stage/claude.tgz}"
if [[ ! -f "$archive" ]]; then
  curl --fail --silent --show-error --location https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.296.tgz -o "$archive"
fi
echo "e966be99b6f047d56165e2ec03822f17a49beebd48ac8efb91dab1e48bcf69a7  $archive" | shasum -a 256 -c -
tar -xzf "$archive" --strip-components=1 -C "$stage/claude"
rm -f "$stage/claude.tgz"
python_bin="${WIDGET_PLAN_PYTHON:-}"
if [[ -z "$python_bin" ]]; then
  uv python install 3.14.9
  python_bin="$(uv python find --managed-python 3.14.9)"
fi
prefix="$("$python_bin" -I -c 'import sys;assert sys.version_info[:3]==(3,14,9);print(sys.base_prefix)')"
cp -L "$python_bin" "$stage/python/bin/python3"
rsync -a --exclude '__pycache__' --exclude 'site-packages' --exclude 'ensurepip' --exclude 'idlelib' --exclude 'tkinter' --exclude '_tkinter*.so' "$prefix/lib/python3.14/" "$stage/python/lib/python3.14/"
# Some standalone distributions link libpython dynamically.
if otool -L "$python_bin" | grep -q 'libpython'; then cp "$prefix/lib/libpython3.14.dylib" "$stage/python/lib/"; fi
site="$stage/python/lib/python3.14/site-packages"
mkdir -p "$site"
if [[ -n "${WIDGET_PLAN_SITE:-}" ]]; then
  ditto "$WIDGET_PLAN_SITE" "$site"
else
  uv pip install --python "$python_bin" --target "$site" --no-deps openai-codex==0.172.0 pydantic==2.14.1 pydantic-core==2.50.1 packaging==26.3 typing-extensions==4.16.0 typing-inspection==0.4.4 annotated-types==0.8.0
fi
"$stage/python/bin/python3" -I -B -c 'from openai_codex.client import CodexClient; from openai_codex.generated.v2_all import GetAccountRateLimitsResponse; import openai_codex; assert openai_codex.__version__=="0.172.0"'
"$runtime/node" --input-type=module -e 'const sdk=await import(process.argv[1]); if(typeof sdk.query!=="function") process.exit(1)' "$stage/claude/sdk.mjs"
echo "$version" > "$stage/version"
rm -rf "$dest"
mv "$stage" "$dest"
