#!/usr/bin/env bash
# Verify this standalone package's committed contents before publication.
set -euo pipefail

fail() { printf 'NOT VERIFIED: %s\n' "$1" >&2; exit 1; }

# Git overrides could silently verify a different repository than this script.
if [[ -n "${GIT_DIR+x}" || -n "${GIT_WORK_TREE+x}" ]]; then
  fail 'Unset GIT_DIR and GIT_WORK_TREE before running verification.'
fi
[[ $# -eq 0 ]] || fail 'This verifier takes no arguments; it always runs the full npm test suite.'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
[[ "$SCRIPT_DIR" == "$ROOT/scripts" ]] || fail 'The verifier must live in this repository scripts directory.'
cd -- "$ROOT"
SHA="$(git rev-parse --verify HEAD)"
GITDIR="$(git rev-parse --absolute-git-dir)"
STAMP="$GITDIR/nuvc-verified-$SHA"
STAMP_TMP=''
trap 'if [[ -n "$STAMP_TMP" ]]; then rm -f -- "$STAMP_TMP"; fi' EXIT

# A failed rerun must not leave an earlier successful stamp for this commit.
rm -f -- "$STAMP"
[[ "$(node -p 'require("./package.json").name')" == "repyh-mcp" ]] || fail 'Unexpected package: run the verifier in its own standalone repository.'

status() { git status --porcelain=v1 --untracked-files=all --ignore-submodules=none; }
DIRTY="$(status)"
if [[ -n "$DIRTY" ]]; then
  printf '%s\n' "$DIRTY" >&2
  fail 'Commit or remove all tracked changes and untracked unignored files before verification; no stamp was written.'
fi

printf 'Verifying %s at %s with the full npm test suite.\n' "$ROOT" "$SHA"
npm test

ROOT_AFTER="$(git rev-parse --show-toplevel)"
SHA_AFTER="$(git rev-parse --verify HEAD)"
GITDIR_AFTER="$(git rev-parse --absolute-git-dir)"
DIRTY_AFTER="$(status)"
[[ "$ROOT_AFTER" == "$ROOT" && "$SHA_AFTER" == "$SHA" && "$GITDIR_AFTER" == "$GITDIR" ]] || fail 'Repository identity or HEAD changed during verification; no stamp was written.'
if [[ -n "$DIRTY_AFTER" ]]; then
  printf '%s\n' "$DIRTY_AFTER" >&2
  fail 'Tracked changes or untracked unignored files appeared during verification; no stamp was written.'
fi

# Publish the completed stamp atomically, never a partially written success.
STAMP_TMP="$(mktemp "$GITDIR/nuvc-verified-$SHA.tmp.XXXXXX")"
{
  printf 'sha=%s\n' "$SHA"
  printf 'root=%s\n' "$ROOT"
  printf 'at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'verified_via=scripts/verify-before-push.sh: npm test (full standalone suite)\n'
} > "$STAMP_TMP"
mv -f -- "$STAMP_TMP" "$STAMP"
STAMP_TMP=''
printf 'VERIFIED: full standalone npm test suite passed for %s in %s.\n' "$SHA" "$ROOT"
printf 'Local verification does not replace independent review or CI. No push was performed.\n'
