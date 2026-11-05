#!/usr/bin/env bash
# Prove the workshop strip is sound, without needing per-chapter branches.
#
# The workshop ships two branches: `main` (the reference build) and
# `workshop/start` (the same tree with every exercise commented out). The
# per-chapter solution branches that used to sit between them are gone --
# catch-up is `make catchup-ch0N`, which uncomments in place. This script is
# what replaced them as the correctness check.
#
# Run it on a CLEAN `main`. It rewrites files in the working tree as it goes
# and restores them at the end.
#
#   tools/verify-chain.sh            # round-trip + every chapter state
#   tools/verify-chain.sh --quick    # round-trip only, no typecheck/validate
set -euo pipefail
cd "$(dirname "$0")/.."

QUICK=${1:-}
FAILED=0

cleanup() { git checkout -q -- . 2>/dev/null || true; }
trap cleanup EXIT

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mOK\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=1; }
skip() { printf '  \033[33mSKIP\033[0m %s\n' "$*"; }

# Probe the Collector image once rather than per state. Docker may be absent,
# stopped, or -- on a managed desktop -- demanding a fresh sign-in, and an
# environment failure reported as six config FAILs sends you off debugging
# entirely the wrong thing.
COLLECTOR_OK=1
docker run --rm otel/opentelemetry-collector-contrib:latest --help >/dev/null 2>&1 || COLLECTOR_OK=0

[[ -z $(git status --porcelain) ]] || { echo "working tree is dirty; commit or stash first"; exit 1; }
BASE=$(git rev-parse --abbrev-ref HEAD)
[[ $BASE == main ]] || echo "note: running against '$BASE', not main"

# Every exercise, in chapter order. Keep in sync with the Makefile's
# catchup-* targets and with tools/strip.py's SPEC.
ALL=(2.1 3.1 3.2 3.3 4.1 5.1 5.2 5.3 6.1 6.2)
declare -a CHAPTER_OF=( [2]="2.1" [3]="3.1 3.2 3.3" [4]="4.1" [5]="5.1 5.2 5.3" [6]="6.1 6.2" )

# ── Invariant 1: the strip is exactly reversible ────────────────────────────
# This is what `solution-ch06 == main` used to assert. It is the single most
# important check here: if it holds, an attendee who completes every exercise
# ends up with the reference build.
say "Invariant 1 — strip is exactly reversible"
python3 tools/strip.py > /dev/null
python3 tools/unstrip.py "${ALL[@]}" > /dev/null
if git diff --quiet; then
  ok "strip -> unstrip(all) is byte-identical to $BASE"
else
  bad "round-trip differs from $BASE:"
  git diff --stat
fi
git checkout -q -- .

# ── Invariant 2: unstrip is idempotent and tolerates hand-done work ─────────
# Attendees toggle the lines *between* the markers, so the markers survive and
# a finished block looks unfinished to a marker match. Running catch-up over
# it must be a no-op, not a failure.
say "Invariant 2 — unstrip is idempotent"
python3 tools/strip.py > /dev/null
python3 tools/unstrip.py 2.1 > /dev/null
BEFORE=$(git diff | shasum)
if python3 tools/unstrip.py 2.1 > /dev/null 2>&1 && [[ $(git diff | shasum) == "$BEFORE" ]]; then
  ok "re-running an already-applied exercise changes nothing"
else
  bad "re-running an applied exercise errored or mutated the tree"
fi
git checkout -q -- .

# ── Invariant 3: every chapter state builds and runs ───────────────────────
# What walking the solution branches used to cover.
say "Invariant 3 — every chapter state is valid"
check_state() {
  local label=$1 bad_state=0
  (cd backend  && npx --no-install tsc --noEmit) || bad_state=1
  (cd frontend && npx --no-install tsc --noEmit) || bad_state=1
  if [[ $COLLECTOR_OK -eq 1 ]]; then
    docker run --rm -v "$PWD/collector-config.yaml:/etc/otelcol/config.yaml:ro" \
      -e DD_SITE=datadoghq.com -e DD_API_KEY=dummy \
      otel/opentelemetry-collector-contrib:latest \
      validate --config=/etc/otelcol/config.yaml >/dev/null 2>&1 || bad_state=1
  fi
  [[ $bad_state -eq 0 ]] && ok "$label" || bad "$label"
}

[[ $COLLECTOR_OK -eq 1 ]] || skip "collector-config validation — Collector image unavailable (docker stopped, or sign-in required). TypeScript is still checked."

if [[ $QUICK == --quick ]]; then
  echo "  skipped (--quick)"
else
  python3 tools/strip.py > /dev/null
  check_state "workshop/start"
  applied=()
  for ch in 2 3 4 5 6; do
    read -ra exs <<< "${CHAPTER_OF[$ch]}"
    applied+=("${exs[@]}")
    python3 tools/unstrip.py "${applied[@]}" > /dev/null
    check_state "end of chapter 0$ch (make catchup-ch0$ch)"
  done
  git checkout -q -- .
fi

say "$([[ $FAILED -eq 0 ]] && echo 'All invariants hold.' || echo 'FAILURES above.')"
exit $FAILED
