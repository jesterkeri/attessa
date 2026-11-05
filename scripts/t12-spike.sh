#!/usr/bin/env bash
# T12 Spike S2, run by Joshua on the EC2 host (c6g.xlarge, allocator 3 vCPU / 3072 MiB) from the repo root after
# `pnpm install --frozen-lockfile && pnpm -r build`. Builds the enclave image and EIF, starts it as the test
# enclave (CID 18, socat port 5006, SPEC §5), saves and inspects its attestation, starts two more (CIDs 16, 17)
# and prints how many run. Stops every enclave and the socat bridge on exit. No keys, no transactions.
set -euo pipefail
[ "$(uname -m)" = aarch64 ] || { echo "run this on the arm64 EC2 host"; exit 1; }
for c in docker nitro-cli socat jq node; do command -v "$c" >/dev/null || { echo "missing: $c"; exit 1; }; done
mkdir -p build
cleanup() {
  nitro-cli terminate-enclave --all >/dev/null 2>&1 || true
  [ -n "${SOCAT:-}" ] && kill "$SOCAT" 2>/dev/null || true
}
trap cleanup EXIT
nitro-cli terminate-enclave --all >/dev/null 2>&1 || true

echo "== docker build"
docker build -q -f enclave/Dockerfile -t attessa/enclave-spike:t12 .
echo "== nitro-cli build-enclave (PCRs)"
nitro-cli build-enclave --docker-uri attessa/enclave-spike:t12 --output-file build/enclave-spike.eif | jq -c .Measurements
run() { nitro-cli run-enclave --eif-path build/enclave-spike.eif --cpu-count 1 --memory 1024 --enclave-cid "$1" | jq -r '"started CID \(.EnclaveCID), \(.NumberOfCPUs) CPU, \(.MemoryMiB) MiB"'; }

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
