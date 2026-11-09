#!/usr/bin/env bash
# Rehearsal phase 3a, run ON THE HOST (ec2-user): check out the pushed rehearsal commit, build the real enclave image,
# build the EIF (non-debug), print its PCRs. No key, no transaction, no service started.
#   SHA=<40 hex> bash phase3-host-build.sh      log: ~/rehearsal/build.log
set -uo pipefail
export PATH=/usr/local/bin:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
SHA=${SHA:?set SHA}
mkdir -p ~/rehearsal
cd /opt/attessa || exit 1
echo "== start $(date -u +%FT%TZ) at $SHA"
[ -z "$(git status --porcelain)" ] || { echo "/opt/attessa dirty"; exit 1; }
git fetch -q origin && git checkout -q --detach "$SHA" && git rev-parse HEAD || exit 2
t=$(date +%s); pnpm install --frozen-lockfile >/dev/null 2>&1 && pnpm -r build >/dev/null 2>&1; echo "pnpm install+build rc=$? $(( $(date +%s) - t ))s"
echo "== freeing the 3 enclave vCPUs for the image build"
sudo systemctl stop nitro-enclaves-allocator.service
t=$(date +%s); docker build -q -f enclave/Dockerfile -t attessa/enclave:rehearsal . ; rc=$?
echo "docker build rc=$rc $(( $(date +%s) - t ))s"
sudo systemctl start nitro-enclaves-allocator.service
[ $rc = 0 ] || exit 3
mkdir -p ~/rehearsal/build
t=$(date +%s); nitro-cli build-enclave --docker-uri attessa/enclave:rehearsal --output-file ~/rehearsal/build/enclave.eif | tee ~/rehearsal/build/measurements.json; echo "nitro-cli build-enclave rc=$? $(( $(date +%s) - t ))s"
echo "REHEARSAL_BUILD_END $(date -u +%FT%TZ)"
