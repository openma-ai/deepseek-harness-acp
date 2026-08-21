#!/usr/bin/env bash

set -euo pipefail

tag_commit="${1:-}"
main_ref="${2:-origin/main}"

if [[ -z "$tag_commit" ]]; then
    echo "usage: $0 <tag-commit> [main-ref]" >&2
    exit 2
fi

if ! git rev-parse --verify --quiet "${tag_commit}^{commit}" >/dev/null; then
    echo "release tag commit does not exist: $tag_commit" >&2
    exit 2
fi

if ! git rev-parse --verify --quiet "${main_ref}^{commit}" >/dev/null; then
    echo "release main ref does not exist: $main_ref" >&2
    exit 2
fi

if ! git merge-base --is-ancestor "$tag_commit" "$main_ref"; then
    echo "release tags must point to a commit on origin/main: $tag_commit is not contained in $main_ref" >&2
    exit 1
fi

echo "release tag commit $tag_commit is contained in $main_ref"
