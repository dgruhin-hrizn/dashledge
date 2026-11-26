#!/bin/bash
# Run the JavaScript suite on a disposable Dashledge registration of Ember's local runner image.
set -euo pipefail
repo=dgruhin-hrizn/dashledge
sha="${1:?Expected main commit}"
label="dashledge-$(uuidgen | tr '[:upper:]' '[:lower:]')"
image=ember-runner-linux:arm64
if ! docker info >/dev/null 2>&1; then
  open -a Docker
  for ((i=0;i<60;i++)); do docker info >/dev/null 2>&1 && break; sleep 2; done
fi
if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker build --platform linux/arm64 -t "$image" "${EMBER_REPO:-$HOME/ember}/ci/runners/linux"
fi
cleanup() { docker rm -f "$label" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# Use stdin for the one-job registration. No host volumes or Docker socket are mounted.
gh api -X POST "repos/$repo/actions/runners/generate-jitconfig" -f name="$label" -F runner_group_id=1 \
  -f 'labels[]=self-hosted' -f 'labels[]=linux' -f 'labels[]=arm64' -f "labels[]=$label" --jq .encoded_jit_config |
  docker run -i --rm --name "$label" --entrypoint /bin/bash "$image" -c 'read -r config && exec ./run.sh --jitconfig "$config"' &
runner_pid=$!
gh workflow run release-check.yml -R "$repo" --ref main -f runner_label="$label"
run=
for ((i=0;i<60;i++)); do
  kill -0 "$runner_pid" || { wait "$runner_pid"; exit 1; }
  run=$(gh run list -R "$repo" --workflow release-check.yml --limit 30 --json displayTitle,databaseId \
    --jq ".[] | select(.displayTitle == \"Release checks $label\") | .databaseId")
  [[ -z "$run" ]] || break
  sleep 2
done
[[ -n "$run" ]] || { echo 'Could not locate the dispatched release check.' >&2; exit 1; }
[[ "$(gh run view "$run" -R "$repo" --json headSha --jq .headSha)" == "$sha" ]] || { echo 'main advanced. Restart the release.' >&2; exit 1; }
gh run watch "$run" -R "$repo" --exit-status
