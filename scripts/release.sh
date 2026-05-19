#!/usr/bin/env bash
# rx-claude-matrix-bridge — one-shot release script.
#
# Usage:
#   bash scripts/release.sh patch        # 0.4.6 → 0.4.7
#   bash scripts/release.sh minor        # 0.4.7 → 0.5.0
#   bash scripts/release.sh major        # 0.5.0 → 1.0.0
#   bash scripts/release.sh 0.9.42       # explicit version
#   bash scripts/release.sh patch --dry  # show what would happen, no writes
#
# Steps:
#   1. Compute the new version from current package.json + bump arg
#   2. Rewrite package.json, .claude-plugin/plugin.json,
#      README.md status + known-limitations heading to the new version
#   3. npm run build (regenerates dist/server.js + dist/daemon.js with
#      the bumped version baked in — server.ts + daemon.ts read it from
#      package.json at startup)
#   4. git add + commit + tag v<version>
#   5. git push origin <current-branch> v<version>
#
# Pre-flight checks: clean working tree, on a branch, package.json
# version parses as semver.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"

# ---------- args ----------

if [[ $# -lt 1 ]]; then
  echo "usage: bash scripts/release.sh <patch|minor|major|X.Y.Z> [--dry]" >&2
  exit 1
fi
BUMP="$1"
DRY=0
[[ "${2:-}" == "--dry" ]] && DRY=1

# ---------- pre-flight ----------

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree dirty — commit or stash first" >&2
  git status --short >&2
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
[[ "$BRANCH" == "HEAD" ]] && { echo "error: detached HEAD, please checkout a branch" >&2; exit 1; }

command -v jq >/dev/null 2>&1 || { echo "error: jq required" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "error: npm required" >&2; exit 1; }

# ---------- compute new version ----------

CURRENT=$(jq -r .version package.json)
[[ "$CURRENT" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] \
  || { echo "error: package.json version '$CURRENT' is not semver" >&2; exit 1; }
MAJ="${BASH_REMATCH[1]}"
MIN="${BASH_REMATCH[2]}"
PAT="${BASH_REMATCH[3]}"

case "$BUMP" in
  patch) NEW="${MAJ}.${MIN}.$((PAT+1))" ;;
  minor) NEW="${MAJ}.$((MIN+1)).0" ;;
  major) NEW="$((MAJ+1)).0.0" ;;
  [0-9]*\.[0-9]*\.[0-9]*) NEW="$BUMP" ;;
  *) echo "error: bump must be patch|minor|major|X.Y.Z, got '$BUMP'" >&2; exit 1 ;;
esac

# Sanity: refuse to "release" a version we already tagged.
if git rev-parse "v${NEW}" >/dev/null 2>&1; then
  echo "error: tag v${NEW} already exists" >&2
  exit 1
fi

echo "Releasing ${CURRENT} → ${NEW} (branch ${BRANCH})"
echo

if (( DRY )); then
  echo "[dry] would update package.json, plugin.json, README.md"
  echo "[dry] would: npm run build"
  echo "[dry] would: git add … && git commit -m 'chore(release): v${NEW}' && git tag -a v${NEW}"
  echo "[dry] would: git push origin ${BRANCH} v${NEW}"
  exit 0
fi

# ---------- bump version strings ----------

# package.json — let jq do it (safer than sed for JSON).
jq --arg v "$NEW" '.version=$v' package.json >package.json.tmp \
  && mv package.json.tmp package.json
echo "  ✓ package.json → $NEW"

jq --arg v "$NEW" '.version=$v' .claude-plugin/plugin.json \
  >.claude-plugin/plugin.json.tmp \
  && mv .claude-plugin/plugin.json.tmp .claude-plugin/plugin.json
echo "  ✓ .claude-plugin/plugin.json → $NEW"

# README "Status" row and "Known limitations" heading.
sed -i \
  -e "s/| \*\*Status\*\* | v[0-9]\+\.[0-9]\+\.[0-9]\+ /| **Status** | v${NEW} /" \
  -e "s/### Known limitations (v[0-9]\+\.[0-9]\+\.[0-9]\+)/### Known limitations (v${NEW})/" \
  README.md
echo "  ✓ README.md → $NEW"

# GitHub Pages landing page — version badge in the hero block.
if [[ -f docs/index.html ]]; then
  sed -i "s|Claude Code plugin · v[0-9]\+\.[0-9]\+\.[0-9]\+|Claude Code plugin · v${NEW}|" docs/index.html
  echo "  ✓ docs/index.html → $NEW"
fi

# ---------- rebuild bundle ----------

echo
echo "Building bundles …"
npm run build >/dev/null
echo "  ✓ dist/server.js + dist/daemon.js"

# ---------- commit, tag, push ----------

echo
echo "Committing + tagging …"
git add package.json .claude-plugin/plugin.json README.md dist/
# Stage Pages page only if it has uncommitted changes (it may not, e.g. on
# a release that doesn't touch it).
git diff --quiet docs/index.html 2>/dev/null || git add docs/index.html
git commit -m "chore(release): v${NEW}" >/dev/null
git tag -a "v${NEW}" -m "v${NEW}"
echo "  ✓ committed + tagged v${NEW}"

echo
echo "Pushing to origin …"
git push origin "$BRANCH" "v${NEW}"
echo
echo "Released v${NEW}."
