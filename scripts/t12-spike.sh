#!/usr/bin/env bash
# T12 Spike S2, run by Joshua on the EC2 host (c6g.xlarge, allocator 3 vCPU / 3072 MiB) from the repo root after
# `pnpm install --frozen-lockfile && pnpm -r build`. Builds the enclave image and EIF, starts it as the test
# enclave (CID 18, socat port 5006, SPEC §5), saves and inspects its attestation, starts two more (CIDs 16, 17)
# and prints how many run. Refuses to start if any enclave already runs on the host (a live seller owns CIDs
# 16 and 17). On exit, including an interrupt, it terminates only the enclaves this run started, by id, and
# stops its socat bridge. It never terminates "all" enclaves. No keys, no transactions.
set -euo pipefail
[ "$(uname -m)" = aarch64 ] || { echo "run this on the arm64 EC2 host"; exit 1; }
for c in docker nitro-cli socat jq node; do command -v "$c" >/dev/null || { echo "missing: $c"; exit 1; }; done
# Strict view of the host: prints the describe-enclaves JSON only if the command succeeded and the result is an
# array whose every record is an object with a non-empty string EnclaveID and a numeric EnclaveCID. null, {},
# malformed records, a command failure or a parse failure all fail, so an unknown state is never read as empty.
enclaves() {
  local out
  out=$(nitro-cli describe-enclaves) || return 1
  jq -e 'type == "array" and all(.[]; type == "object" and (.EnclaveID | type == "string" and length > 0) and (.EnclaveCID | type == "number"))' <<<"$out" >/dev/null 2>&1 || return 1
  printf '%s' "$out"
}
HOST=$(enclaves) || { echo "refusing to run: cannot establish the set of running enclaves (nitro-cli describe-enclaves failed or returned something other than a list of enclave records)."; exit 1; }
RUNNING=$(jq length <<<"$HOST")
[ "$RUNNING" = 0 ] || { echo "refusing to run: $RUNNING enclave(s) already running on this host (a live seller may own CIDs 16-18). Stop them yourself first; this script never terminates enclaves it did not start."; exit 1; }
mkdir -p build
STARTED=()     # enclave ids this run started, known from run-enclave output
ATTEMPTED=()   # every CID this run asked run-enclave to start, recorded before the call
KNOWN=" "      # CIDs whose id is already in STARTED
cleanup() {
  trap - EXIT INT TERM
  local id cid rc=0 found
  # A launch can start an enclave and still fail or print unparsable output (or be interrupted): find any
  # attempted CID we hold no id for in the strict describe-enclaves list. This host had no enclave when we began.
  for cid in ${ATTEMPTED[@]+"${ATTEMPTED[@]}"}; do
    case "$KNOWN" in *" $cid "*) continue ;; esac
    if found=$(enclaves); then
      id=$(jq -r --argjson c "$cid" '.[] | select(.EnclaveCID == $c) | .EnclaveID' <<<"$found")
      [ -z "$id" ] || STARTED+=("$id")
    else
      echo "cannot list enclaves to look for CID $cid; check it and stop it by hand" >&2; rc=1
    fi
  done
  for id in ${STARTED[@]+"${STARTED[@]}"}; do
    nitro-cli terminate-enclave --enclave-id "$id" >/dev/null 2>&1 || true
  done
  if [ -n "${SOCAT:-}" ]; then kill "$SOCAT" 2>/dev/null || true; wait "$SOCAT" 2>/dev/null || true; fi
  return $rc
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "== docker build"
docker build -q -f enclave/Dockerfile -t attessa/enclave-spike:t12 .
echo "== nitro-cli build-enclave (PCRs)"
nitro-cli build-enclave --docker-uri attessa/enclave-spike:t12 --output-file build/enclave-spike.eif | jq -c .Measurements
run() {
  local out id
  ATTEMPTED+=("$1")   # before the call: if it starts something and then fails, cleanup still knows the CID
  out=$(nitro-cli run-enclave --eif-path build/enclave-spike.eif --cpu-count 1 --memory 1024 --enclave-cid "$1") || return 1
  id=$(jq -r .EnclaveID <<<"$out") && [ -n "$id" ] && [ "$id" != null ] || { echo "cannot read the EnclaveID of CID $1; cleanup will look it up by CID"; return 1; }
  KNOWN+="$1 "; STARTED+=("$id")   # recorded at once so cleanup terminates exactly this enclave
  jq -r '"started CID \(.EnclaveCID), \(.NumberOfCPUs) CPU, \(.MemoryMiB) MiB"' <<<"$out"
}

echo "== first enclave (test layout: CID 18, port 5006)"
run 18
socat TCP-LISTEN:5006,bind=127.0.0.1,fork,reuseaddr VSOCK-CONNECT:18:5000 & SOCAT=$!
node scripts/t12-configure.mjs 5006 att.bin
echo "== verify, part 1"
node scripts/inspect-attestation.mjs att.bin

echo "== two more (CIDs 16, 17)"
run 16 || echo "CID 16 did not start"
run 17 || echo "CID 17 did not start"
echo "== verify, part 2: enclaves running"
nitro-cli describe-enclaves | jq length
