#!/usr/bin/env bash
# Rehearsal phase 3a', ON THE HOST: a clean (--no-cache) rebuild of the enclave image and EIF, to see whether the PCRs match the cached build.
set -uo pipefail
export PATH=/usr/local/bin:$PATH
cd /opt/attessa || exit 1
echo "== start $(date -u +%FT%TZ)"
sudo systemctl stop nitro-enclaves-allocator.service
t=$(date +%s); docker build --no-cache -q -f enclave/Dockerfile -t attessa/enclave:nocache . ; rc=$?
echo "docker build --no-cache rc=$rc $(( $(date +%s) - t ))s"
sudo systemctl start nitro-enclaves-allocator.service
[ $rc = 0 ] || exit 3
t=$(date +%s); nitro-cli build-enclave --docker-uri attessa/enclave:nocache --output-file ~/rehearsal/build/enclave-nocache.eif; echo "build-enclave rc=$? $(( $(date +%s) - t ))s"
echo "REHEARSAL_NOCACHE_END $(date -u +%FT%TZ)"
