#!/usr/bin/env bash
# Uploads one file as an asset of a GitHub release with as few API requests as possible (the GITHUB_TOKEN of a repository
# gets ~1000 requests/hour): one POST, no release lookup, no asset listing. Only when the asset exists already (a rebuilt unit)
# the old one is looked up and deleted. Rate limits (429, 403 "secondary rate limit") are waited out: the pause is the Retry-After
# the server sends (or until x-ratelimit-reset), else it grows with the attempt; other errors retry with growing pauses too.
# Called one file after the other (never in parallel), with a short pause after each upload.
#   collectors/osm-release-upload.sh <owner/repo> <release-id> <file>        needs GH_TOKEN and the gh CLI
set -uo pipefail
REPO=${1:?owner/repo}; ID=${2:?release id}; FILE=${3:?file}
NAME=$(basename "$FILE")

# seconds to wait for a failed response (headers + body in $1), or empty
wait_for() {
  local ra reset now
  ra=$(echo "$1" | grep -i '^retry-after:' | head -1 | tr -dc '0-9')
  if [ -n "$ra" ]; then echo "$ra"; return; fi
  reset=$(echo "$1" | grep -i '^x-ratelimit-reset:' | head -1 | tr -dc '0-9')
  remaining=$(echo "$1" | grep -i '^x-ratelimit-remaining:' | head -1 | tr -dc '0-9')
  if [ -n "$reset" ] && [ "${remaining:-1}" = "0" ]; then now=$(date +%s); echo $((reset > now ? reset - now + 5 : 60)); return; fi
}

for i in 1 2 3 4 5 6 7 8 9 10; do
  if out=$(gh api --include --method POST -H "Content-Type: application/octet-stream" "https://uploads.github.com/repos/$REPO/releases/$ID/assets?name=$NAME" --input "$FILE" 2>&1); then
    echo "uploaded $NAME"
    sleep 2
    exit 0
  fi
  if echo "$out" | grep -q "already_exists"; then
    aid=$(gh api --paginate "repos/$REPO/releases/$ID/assets" --jq ".[] | select(.name==\"$NAME\") | .id" | head -1)
    [ -n "$aid" ] && gh api -X DELETE "repos/$REPO/releases/assets/$aid" >/dev/null
    continue
  fi
  w=$(wait_for "$out")
  if [ -z "$w" ]; then
    if echo "$out" | grep -qiE 'HTTP/[0-9.]+ (429|403)|rate limit|abuse'; then w=$((i * 90)); else w=$((i * 60)); fi
  fi
  [ "$w" -gt 900 ] && w=900
  echo "attempt $i/10 for $NAME failed: $(echo "$out" | grep -iE '^HTTP/|message' | head -c 300) - waiting ${w}s"
  sleep "$w"
done
echo "::error::upload of $NAME failed"
exit 1
