#!/bin/bash
# go-mutesting calls this for every mutant. Exit code: 0 killed, 1 survived, 2 skipped.
set -u

# TTM_MUTATION_RANGES: "start-end ..." lines of this file in the gate's scope; empty is the whole file.
if [[ -n ${TTM_MUTATION_RANGES:-} ]]; then
    line=$(diff "$MUTATE_ORIGINAL" "$MUTATE_CHANGED" | sed -n '1s/^\([0-9]*\).*/\1/p')
    in_scope=0
    for range in $TTM_MUTATION_RANGES; do
        ((line >= ${range%-*} && line <= ${range#*-})) && in_scope=1
    done
    ((in_scope)) || exit 2
fi

cp "$MUTATE_ORIGINAL" "$MUTATE_ORIGINAL.orig"
restore() { mv "$MUTATE_ORIGINAL.orig" "$MUTATE_ORIGINAL"; }
trap restore EXIT
cp "$MUTATE_CHANGED" "$MUTATE_ORIGINAL"

# A mutant that doesn't compile (or fails vet) says nothing about the tests: it must not count as killed.
go test -run '^$' "$MUTATE_PACKAGE" >/dev/null 2>&1 || exit 2

if go test -count=1 -timeout "${MUTATE_TIMEOUT}s" "$MUTATE_PACKAGE" >/dev/null 2>&1; then exit 1; fi
exit 0
