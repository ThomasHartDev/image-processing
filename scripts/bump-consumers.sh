#!/usr/bin/env bash
# Bump the @thomashartdev/image-processing version pin across all known
# consumer projects and open a PR in each.
#
# Usage:
#   ./scripts/bump-consumers.sh v0.4.0
#
# Assumes:
#   - gh CLI authenticated (gh auth status)
#   - pnpm available
#   - Local clones at /root/projects/{atlas,pixel-wand}, on master, clean
#
# Add new consumers to CONSUMERS below as they show up.

set -euo pipefail

NEW_TAG="${1:-}"
if [[ -z "$NEW_TAG" ]]; then
  echo "usage: $0 <new-tag>   (e.g. v0.4.0)" >&2
  exit 1
fi

if ! [[ "$NEW_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  echo "tag must look like v0.4.0 (got: $NEW_TAG)" >&2
  exit 1
fi

# Verify the tag exists on the image-processing remote.
if ! git -C "$(dirname "$0")/.." rev-parse --verify "refs/tags/$NEW_TAG" >/dev/null 2>&1; then
  echo "tag $NEW_TAG does not exist locally. did you forget 'git push --tags'?" >&2
  exit 1
fi

# Each consumer is: <local-path>:<github-slug>:<package-json-path>
# package-json-path is relative to the local-path; pixel-wand has nested
# package.jsons (apps/pixel-wand and packages/pixel-wand-mcp), so we list
# them as separate consumer entries.
CONSUMERS=(
  "/root/projects/atlas:ThomasHartDev/atlas:package.json"
  "/root/projects/pixel-wand:ThomasHartDev/pixel-wand:apps/pixel-wand/package.json"
  "/root/projects/pixel-wand:ThomasHartDev/pixel-wand:packages/pixel-wand-mcp/package.json"
)

# Group consumers by repo path so we open one PR per repo, not one per file.
declare -A PR_BRANCHES
declare -A PR_FILES

for entry in "${CONSUMERS[@]}"; do
  IFS=':' read -r repo_path slug pkg_rel <<<"$entry"

  if [[ ! -d "$repo_path" ]]; then
    echo "skipping $slug: $repo_path not found locally" >&2
    continue
  fi

  pkg_full="$repo_path/$pkg_rel"
  if ! grep -q "ThomasHartDev/image-processing" "$pkg_full" 2>/dev/null; then
    echo "skipping $pkg_rel in $slug: no image-processing dep here" >&2
    continue
  fi

  # Track files per repo for one combined PR.
  if [[ -z "${PR_BRANCHES[$repo_path]:-}" ]]; then
    PR_BRANCHES[$repo_path]="thomas/chore/bump-image-processing-$NEW_TAG"
    PR_FILES[$repo_path]=""
  fi
  PR_FILES[$repo_path]+=" $pkg_rel"
done

# Process each repo: branch off master, edit, install, commit, push, open PR.
for repo_path in "${!PR_BRANCHES[@]}"; do
  branch="${PR_BRANCHES[$repo_path]}"
  files="${PR_FILES[$repo_path]}"

  echo
  echo "=== $repo_path ==="
  cd "$repo_path"

  # Refuse to bump if working tree dirty — caller should commit/stash first.
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "  working tree dirty, skipping. commit/stash first." >&2
    continue
  fi

  git checkout master
  git pull --ff-only
  git checkout -B "$branch"

  for pkg_rel in $files; do
    sed -i \
      "s|github:ThomasHartDev/image-processing#v[0-9.]\+|github:ThomasHartDev/image-processing#$NEW_TAG|g" \
      "$pkg_rel"
    echo "  updated $pkg_rel"
  done

  pnpm install
  git add -A
  git commit -m "chore: bump @thomashartdev/image-processing to $NEW_TAG"
  git push -u origin "$branch"

  pr_url=$(gh pr create \
    --base master \
    --head "$branch" \
    --title "chore: bump image-processing to $NEW_TAG" \
    --body "Routine version bump. Pulls in whatever shipped in [$NEW_TAG](https://github.com/ThomasHartDev/image-processing/releases/tag/$NEW_TAG)." \
    2>&1 | tail -1)
  echo "  PR: $pr_url"
done

echo
echo "done. review the PRs, merge when CI is green."
