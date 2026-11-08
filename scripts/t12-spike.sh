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
RUNNING=$(nitro-cli describe-enclaves | jq length)
[ "$RUNNING" = 0 ] || { echo "refusing to run: $RUNNING enclave(s) already running on this host (a live seller may own CIDs 16-18). Stop them yourself first; this script never terminates enclaves it did not start."; exit 1; }
mkdir -p build
STARTED=()
cleanup() {
  trap - EXIT INT TERM
  local id
  for id in ${STARTED[@]+"${STARTED[@]}"}; do
    nitro-cli terminate-enclave --enclave-id "$id" >/dev/null 2>&1 || true
  done
  if [ -n "${SOCAT:-}" ]; then kill "$SOCAT" 2>/dev/null || true; wait "$SOCAT" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "== docker build"
docker build -q -f enclave/Dockerfile -t attessa/enclave-spike:t12 .
echo "== nitro-cli build-enclave (PCRs)"
nitro-cli build-enclave --docker-uri attessa/enclave-spike:t12 --output-file build/enclave-spike.eif | jq -c .Measurements
run() {
  local out id
  out=$(nitro-cli run-enclave --eif-path build/enclave-spike.eif --cpu-count 1 --memory 1024 --enclave-cid "$1") || return 1
  id=$(jq -r .EnclaveID <<<"$out") && [ -n "$id" ] && [ "$id" != null ] || { echo "cannot read the EnclaveID of CID $1; stop it by hand"; return 1; }
  STARTED+=("$id")   # recorded at once so cleanup terminates exactly this enclave
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
