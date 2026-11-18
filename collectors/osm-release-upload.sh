#!/usr/bin/env bash
# Uploads one file as an asset of a GitHub release with as few API requests as possible (the GITHUB_TOKEN of a repository
# gets ~1000 requests/hour, and the first run of osm-tiles uploads from hundreds of jobs): one POST, no release lookup, no asset
# listing. Only when the asset exists already (a rebuilt region) the old one is looked up and deleted. Retries with growing pauses
# on rate limits and other errors.
#   collectors/osm-release-upload.sh <owner/repo> <release-id> <file>        needs GH_TOKEN and the gh CLI
set -uo pipefail
REPO=${1:?owner/repo}; ID=${2:?release id}; FILE=${3:?file}
NAME=$(basename "$FILE")
for i in 1 2 3 4 5 6 7 8; do
  if out=$(gh api --method POST -H "Content-Type: application/octet-stream" "https://uploads.github.com/repos/$REPO/releases/$ID/assets?name=$NAME" --input "$FILE" 2>&1); then
    echo "uploaded $NAME"
    exit 0
  fi
  if echo "$out" | grep -q "already_exists"; then
    aid=$(gh api --paginate "repos/$REPO/releases/$ID/assets" --jq ".[] | select(.name==\"$NAME\") | .id" | head -1)
    [ -n "$aid" ] && gh api -X DELETE "repos/$REPO/releases/assets/$aid" >/dev/null
    continue
  fi
  echo "attempt $i/8 for $NAME failed: $(echo "$out" | head -c 300)"
  sleep $((i * 60))
done
echo "::error::upload of $NAME failed"
exit 1
