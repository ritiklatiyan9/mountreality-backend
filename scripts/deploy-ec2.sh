#!/usr/bin/env bash
set -Eeuo pipefail

app_dir="${1:?EC2 application directory is required}"
branch="${2:-main}"
pm2_app_name="${3:?PM2 application name is required}"
health_url="${4:?Backend health URL is required}"

fail() {
  printf 'Deployment failed: %s\n' "$*" >&2
  exit 1
}

for command_name in git node npm pm2 curl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is not installed on EC2"
done

[ -d "$app_dir/.git" ] || fail "$app_dir is not a Git checkout"
cd "$app_dir"

tracked_changes="$(git status --porcelain --untracked-files=no)"
[ -z "$tracked_changes" ] || fail "tracked files on EC2 have local changes; commit or remove them before deploying"

current_branch="$(git branch --show-current)"
[ "$current_branch" = "$branch" ] || fail "EC2 checkout is on '$current_branch', expected '$branch'"

printf 'Fetching origin/%s...\n' "$branch"
git fetch --prune origin "$branch"
git merge --ff-only FETCH_HEAD

printf 'Installing production dependencies...\n'
npm ci --omit=dev --no-audit --no-fund
node --check src/server.js
node --check src/app.js

if pm2 describe "$pm2_app_name" >/dev/null 2>&1; then
  printf 'Restarting PM2 application %s...\n' "$pm2_app_name"
  pm2 restart "$pm2_app_name" --update-env
else
  printf 'Starting PM2 application %s...\n' "$pm2_app_name"
  pm2 start src/server.js --name "$pm2_app_name" --cwd "$app_dir" --time
fi

pm2 save

printf 'Waiting for %s...\n' "$health_url"
for attempt in $(seq 1 20); do
  if curl --fail --silent --show-error --max-time 5 "$health_url" >/dev/null; then
    printf 'Backend deployment is healthy at commit %s.\n' "$(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 2
done

pm2 logs "$pm2_app_name" --lines 80 --nostream || true
fail "health check did not pass after 40 seconds"
