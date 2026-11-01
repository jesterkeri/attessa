#!/usr/bin/env bash
# Pins the build Slither analyses. Slither (crytic-compile) runs `forge build` in contracts/, so what it
# analyses is whatever foundry's effective configuration says: which folder is src, which folders are
# libs, test and script, allow_paths, and every remapping (from foundry.toml, any [profile.*] section,
# remappings.txt, or auto-detected from lib/ folders). Changing any of these can take contracts/src out
# of the analysis or compile it against a copy of nitro-validator other than the pinned submodule. So
# this pins the effective result, not single files:
#   1. no file named .env anywhere under contracts/ (forge loads contracts/.env into its environment,
#      where FOUNDRY_SRC, FOUNDRY_REMAPPINGS, FOUNDRY_PROFILE and the like override foundry.toml). Its
#      contents are never read.
#   2. no FOUNDRY_* or DAPP_* variable in this environment (the same overrides; names only are printed).
#   3. SHA-256 of `forge config --json`, normalised (keys sorted, compact), equals argv[1].
#   4. SHA-256 of `forge remappings`, sorted, equals argv[2].
#   5. the source set: a build of contracts/src with the same skips as Slither's own build
#      (forge build --build-info --deny never --skip ./test/** ./script/** --force), into a temporary
#      out/ and cache/ that are removed afterwards, must compile only files under src/ or
#      lib/nitro-validator/src/ (the build-info source names). Any other file fails, by path: a src
#      contract importing a copy of the validator from vendor/, lib/<other>/, test/ or a relative path
#      outside contracts/ would otherwise build against code the pin check does not hold.
#      Accepted limit: a renamed copy of the validator inside src/ passes this check. Slither then
#      analyses all of it as this repo's own code, and it is product code under review like any other
#      file in src/.
# Stripped before hashing, because it differs from machine to machine and does not change the build:
#   etherscan_api_key (taken from the ETHERSCAN_API_KEY environment variable; also a secret).
# forge 1.8.1 prints no absolute path in either output (src, out, libs, cache_path, remappings and
# fs_permissions are relative to contracts/), and with no FOUNDRY_* variables threads, workers and
# verbosity keep their defaults, so nothing else is stripped. A user-level ~/.foundry/foundry.toml would
# change the hash; neither the CI runner nor the dev machine has one.
# Run from the repository root, with the forge version in contracts/FOUNDRY_VERSION. The CI slither job
# runs it before Slither, with the two hashes on its command line.
#   check : scripts/check-slither-build.sh <config-sha256> <remappings-sha256>
#   print : scripts/check-slither-build.sh --print   (the two hashes for the current tree, to update ci.yml)
set -uo pipefail
cd contracts 2>/dev/null || { echo "FAIL: run from the repository root (no contracts/ here)"; exit 1; }
bad=0
fail() { echo "FAIL: $*"; bad=1; }

envs=$(find . -name .env -print 2>&1) || fail "find .env failed: $envs"
[ -z "$envs" ] || fail "a .env file under contracts/ would change forge's configuration:"$'\n'"$envs"
vars=$(env | grep -oE '^(FOUNDRY|DAPP)_[A-Za-z0-9_]*=' | tr -d '=')
[ -z "$vars" ] || fail "foundry configuration variables are set in the environment:"$'\n'"$vars"
[ "$bad" = 0 ] || exit 1

cfg=$(forge config --json 2>/dev/null) || { echo "FAIL: forge config --json failed"; exit 1; }
cfg_sha=$(printf '%s' "$cfg" | python3 -I -c '
import json, sys
c = json.load(sys.stdin)
c.pop("etherscan_api_key", None)
sys.stdout.write(json.dumps(c, sort_keys=True, separators=(",", ":")))' | sha256sum | cut -d' ' -f1) &&
  [ -n "$cfg_sha" ] || { echo "FAIL: could not normalise forge config --json"; exit 1; }
remaps=$(forge remappings 2>/dev/null) || { echo "FAIL: forge remappings failed"; exit 1; }
remap_sha=$(printf '%s\n' "$remaps" | LC_ALL=C sort | sha256sum | cut -d' ' -f1)

if [ "${1:-}" = --print ]; then
  echo "forge config --json (normalised): $cfg_sha"
  echo "forge remappings (sorted):        $remap_sha"
  printf '%s\n' "$remaps"
  exit 0
fi
[ $# = 2 ] || { echo "usage: $0 <config-sha256> <remappings-sha256> | --print"; exit 1; }
[ "$cfg_sha" = "$1" ] || fail "forge's effective configuration changed (sha256 $cfg_sha, pinned $1): src, libs, remappings, allow_paths or a profile no longer match the pinned build"
[ "$remap_sha" = "$2" ] || fail "forge's remappings changed (sha256 $remap_sha, pinned $2):"$'\n'"$remaps"

tmp=$(mktemp -d) || { echo "FAIL: mktemp failed"; exit 1; }
trap 'rm -rf "$tmp"' EXIT
if forge build --build-info --deny never --skip './test/**' './script/**' --force \
     --out "$tmp/out" --cache-path "$tmp/cache" > "$tmp/build.log" 2>&1; then
  srcs=$(python3 -I -c '
import glob, json, sys
files = glob.glob(sys.argv[1] + "/*.json")
if not files:
    sys.exit("no build-info written")
names = set()
for f in files:
    names.update(json.load(open(f))["input"]["sources"])
for n in sorted(names):
    ok = (n.startswith("src/") or n.startswith("lib/nitro-validator/src/")) and \
         "/../" not in n and "/./" not in n and "//" not in n
    print(("ok  " if ok else "BAD ") + n)' "$tmp/out/build-info" 2>&1) ||
    fail "could not read the source set from build-info: $srcs"
  badsrc=$(printf '%s\n' "$srcs" | sed -n 's/^BAD //p')
  [ -z "$badsrc" ] || fail "the build of contracts/src compiles files outside src/ and lib/nitro-validator/src/:"$'\n'"$badsrc"
  printf '%s\n' "$srcs" | grep -q '^ok  src/' || fail "the build of contracts/src compiled nothing from src/"
else
  fail "forge build of contracts/src failed:"$'\n'"$(tail -20 "$tmp/build.log")"
fi
[ "$bad" = 0 ] && echo "ok: forge build configuration and remappings match the pinned hashes; the build compiles only src/ and lib/nitro-validator/src/"
exit "$bad"
