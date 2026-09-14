#!/usr/bin/env bash
# Compare the working tree's protos against the most recent released tag.
#
# Skips cleanly when no tag exists — a first release has nothing to be
# backwards-compatible WITH, and failing the very first CI run on that basis
# would teach everyone to ignore this job.
#
# Requires full history: CI must check out with fetch-depth 0, or `git tag`
# comes back empty on a repo that does have tags and this silently passes.
set -euo pipefail

tag="$(git tag --list 'v*' --sort=-version:refname | head -n 1)"

if [ -z "${tag}" ]; then
  echo "No v* tag found — this is the first release. Skipping the breaking-change check."
  exit 0
fi

echo "Checking for breaking changes against ${tag} (category FILE — see buf.yaml)."
npx buf breaking --against ".git#tag=${tag}"
echo "No breaking changes against ${tag}."
