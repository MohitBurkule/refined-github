#!/usr/bin/env bash
# Rebase the local feature branch on upstream/main and rebuild the extension.
set -euo pipefail

cd "$(dirname "$0")/.."

branch="commit-lines-changed-on-timeline"
current="$(git branch --show-current)"

if [[ -n "$(git status --porcelain)" ]]; then
	echo "Working tree not clean, stash or commit first:" >&2
	git status --porcelain >&2
	exit 1
fi

git fetch upstream main
git checkout "$branch"
git rebase upstream/main

if [[ "$current" != "$branch" ]]; then
	git checkout "$current"
fi

npm ci --no-audit --no-fund
npm run build

echo "Rebased and rebuilt. Load /home/mohit/refined-github/distribution as unpacked in chrome://extensions."
