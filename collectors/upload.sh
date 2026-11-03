#!/usr/bin/env bash
# Uploads a directory to an R2 bucket (S3 API) and merges its manifest.json.
#   collectors/upload.sh <dir> <bucket> <cache-control> [--collapse-manifest] [--replace-dirs] [--cache-prefix <prefix/>=<cache-control>]
# Needs AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (R2 token of that bucket) and R2_ACCOUNT_ID, plus the aws CLI and node.
# No --delete: a task that failed keeps its old objects. manifest.json is downloaded, merged with the keys of <dir>
# (collectors/manifest.mjs) and uploaded last; for orbis-live that keeps the entries of the clock worker.
# --replace-dirs: every top-level directory of <dir> replaces its prefix completely (sync --delete, osm-tiles: a region's
# tiles that no longer exist disappear); loose top-level files are uploaded afterwards (tile lists, meta.json last).
# --cache-prefix: files below <prefix/> get their own Cache-Control (synced separately, the main sync excludes the prefix).
# Without credentials nothing is uploaded (local runs, forks).
set -euo pipefail

DIR=${1:?usage: upload.sh <dir> <bucket> <cache-control> [--collapse-manifest]}
BUCKET=${2:?bucket}
CACHE=${3:?cache-control}
COLLAPSE=
REPLACE=
PFX=
PFX_CACHE=
set -- "${@:4}"
while [ $# -gt 0 ]; do
  a=$1; shift
  case "$a" in
    --cache-prefix) [ $# -gt 0 ] || { echo "--cache-prefix needs prefix/=cache-control" >&2; exit 2; }; PFX=${1%%=*}; PFX_CACHE=${1#*=}; shift ;;
    --collapse-manifest) COLLAPSE=--collapse ;;
    --replace-dirs) REPLACE=1 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

if [ -z "${R2_ACCOUNT_ID:-}" ] || [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  echo "::warning::R2 credentials missing - upload of $DIR to $BUCKET skipped"
  exit 0
fi

# R2 does not understand the checksum headers of newer AWS CLI versions
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
export AWS_DEFAULT_REGION=auto
EP="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
HERE=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# manifest first: it needs the mtimes of the files, and a failed download simply starts a new one
aws s3 cp "s3://$BUCKET/manifest.json" "$TMP/old.json" --endpoint-url "$EP" --only-show-errors 2>/dev/null || echo '{}' > "$TMP/old.json"
node "$HERE/manifest.mjs" "$DIR" "$TMP/old.json" "$TMP/manifest.json" $COLLAPSE

# manifest.json inside <dir> (if any) is never uploaded from there
if [ -n "$REPLACE" ]; then
  for d in "$DIR"/*/; do
    [ -d "$d" ] || continue
    aws s3 sync "$d" "s3://$BUCKET/$(basename "$d")/" --endpoint-url "$EP" --delete --cache-control "$CACHE" --only-show-errors
  done
  aws s3 sync "$DIR" "s3://$BUCKET/" --endpoint-url "$EP" --exclude "*/*" --exclude manifest.json --exclude meta.json \
    --cache-control "$CACHE" --only-show-errors
  [ -f "$DIR/meta.json" ] && aws s3 cp "$DIR/meta.json" "s3://$BUCKET/meta.json" --endpoint-url "$EP" --cache-control "$CACHE" --only-show-errors
elif [ -n "$PFX" ]; then
  aws s3 sync "$DIR" "s3://$BUCKET/" --endpoint-url "$EP" --exclude manifest.json --exclude "$PFX*" --cache-control "$CACHE" --only-show-errors
  [ -d "$DIR/$PFX" ] && aws s3 sync "$DIR/$PFX" "s3://$BUCKET/$PFX" --endpoint-url "$EP" --cache-control "$PFX_CACHE" --only-show-errors
else
  aws s3 sync "$DIR" "s3://$BUCKET/" --endpoint-url "$EP" --exclude manifest.json --cache-control "$CACHE" --only-show-errors
fi
aws s3 cp "$TMP/manifest.json" "s3://$BUCKET/manifest.json" --endpoint-url "$EP" \
  --cache-control "public, max-age=60, stale-while-revalidate=300" --content-type application/json --only-show-errors
echo "uploaded $DIR to $BUCKET"
