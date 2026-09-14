#!/usr/bin/env bash
# Compare the working tree's protos against the PREVIOUS release tag.
#
# "Previous" is load-bearing. At tag-push time the highest v* tag is the tag
# being released, so selecting it naively compares a release against itself and
# waves a contract break straight through. Tags pointing at HEAD are therefore
# excluded from the baseline.
#
# Skips cleanly when there is no earlier tag — a first release has nothing to be
# backwards-compatible WITH, and failing the very first run on that basis would
# teach everyone to ignore this job.
#
# Refuses to run in a shallow clone. A shallow checkout sees no tags at all, so
# the skip path would report "first release" while a real breaking change sits
# in the tree — a pass for the wrong reason, which is worse than a failure.
#
# Usage:
#   buf-breaking.sh                     run the check
#   buf-breaking.sh --print-baseline    print the tag that would be used, then exit
set -euo pipefail

print_only=0
if [ "${1:-}" = "--print-baseline" ]; then
  print_only=1
fi

if [ "$(git rev-parse --is-shallow-repository 2>/dev/null || echo false)" = "true" ]; then
  echo "ERROR: shallow clone — tags are not visible, so the breaking check cannot find a baseline." >&2
  echo "       Check out with fetch-depth: 0 (CI already does)." >&2
  exit 1
fi

head_tags="$(git tag --points-at HEAD 2>/dev/null || true)"
baseline=""

while IFS= read -r tag; do
  [ -n "${tag}" ] || continue
  # Skip the release being cut: its tag is on HEAD.
  if printf '%s\n' "${head_tags}" | grep -qxF -- "${tag}"; then
    continue
  fi
  baseline="${tag}"
  break
done <<< "$(git tag --list 'v*' --sort=-version:refname 2>/dev/null || true)"

if [ -z "${baseline}" ]; then
  echo "No v* tag to compare against — this is the first release. Skipping the breaking-change check."
  exit 0
fi

if [ "${print_only}" -eq 1 ]; then
  echo "${baseline}"
  exit 0
fi

echo "Checking for breaking changes against ${baseline} (category FILE — see buf.yaml)."
npx buf breaking --against ".git#tag=${baseline}"
echo "No breaking changes against ${baseline}."
