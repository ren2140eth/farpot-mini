#!/usr/bin/env bash
# Preflight wrapper around forge. Turns the two failure modes that produce confusing errors
# into clear, actionable messages:
#   1. uninitialised submodules (a fresh `git clone` without --recurse-submodules)
#   2. a fork run with BASE_RPC_URL unset
#
# Usage: scripts/forge.sh <forge-subcommand> [args...]
#        FORK=1 scripts/forge.sh test ...   # additionally requires BASE_RPC_URL
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$ROOT/contracts"

fail() {
    printf '\n\033[31merror:\033[0m %s\n\n' "$1" >&2
    exit 1
}

# --- 1. submodules -----------------------------------------------------------------------
missing=()
[ -f "$CONTRACTS/lib/forge-std/src/Test.sol" ] || missing+=("contracts/lib/forge-std")
[ -f "$CONTRACTS/lib/solady/src/utils/FixedPointMathLib.sol" ] || missing+=("contracts/lib/solady")

if [ ${#missing[@]} -gt 0 ]; then
    fail "contract dependencies are not initialised: ${missing[*]}

  These are git submodules pinned to release tags (forge-std v1.16.2, solady v0.1.26).
  Fix with:

      git submodule update --init --recursive

  Or clone with them next time:

      git clone --recurse-submodules <repo>

  In CI, set 'submodules: recursive' on actions/checkout."
fi

# --- 2. fork RPC -------------------------------------------------------------------------
# The fork tests pin their own blocks with `vm.createSelectFork(vm.envString("BASE_RPC_URL"), n)`,
# so BASE_RPC_URL must be exported — but do NOT also pass `--fork-url`. Doing so creates a
# DEFAULT fork at the latest block, and executing against Base's tip makes foundry's op-revm
# panic with "Missing operator fee scalar for isthmus L1 Block". Pinned blocks are unaffected.
if [ "${FORK:-0}" = "1" ] && [ -z "${BASE_RPC_URL:-}" ]; then
    fail "BASE_RPC_URL is not set, and this is a fork run.

  Fork tests execute against live Base mainnet state. Set a Base RPC endpoint:

      export BASE_RPC_URL=https://mainnet.base.org

  A public endpoint is fine for reads, but note base.publicnode.com refuses historical
  archive requests, so prefer mainnet.base.org for fork pinning."
fi

# --- run -----------------------------------------------------------------------------------
command -v forge >/dev/null 2>&1 || fail "forge not found on PATH. Install Foundry: https://getfoundry.sh"

# Run from INSIDE contracts/ rather than passing `--root`. `--root` sets where config is
# discovered, but forge still resolves some paths against the working directory — notably the
# invariant failure-replay cache (`cache/invariant/failures/`), which Phase 3 caught landing in
# the REPO ROOT as an untracked, un-ignored directory that `.gitignore`'s `/contracts/cache/`
# rule could never match. Changing directory makes every relative path resolve under
# contracts/, which is already ignored, instead of chasing each stray writer with a new rule.
cd "$CONTRACTS"
exec forge "$@"
