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
  # -s: more than one JSON document is not a list of enclaves (plain -e reports only the last one's status).
  jq -se 'length == 1 and (.[0] | type == "array" and all(.[]; type == "object" and (.EnclaveID | type == "string" and length > 0) and (.EnclaveCID | type == "number")))' <<<"$out" >/dev/null 2>&1 || return 1
  printf '%s' "$out"
}
HOST=$(enclaves) || { echo "refusing to run: cannot establish the set of running enclaves (nitro-cli describe-enclaves failed or returned something other than a list of enclave records)."; exit 1; }
RUNNING=$(jq length <<<"$HOST")
[ "$RUNNING" = 0 ] || { echo "refusing to run: $RUNNING enclave(s) already running on this host (a live seller may own CIDs 16-18). Stop them yourself first; this script never terminates enclaves it did not start."; exit 1; }
mkdir -p build
OUTD=$(mktemp -d)   # run-enclave output, one file per attempt, written by the command itself so a signal cannot lose it
# Each launch gets its own name, t12spike-<pid>-<cid>, reported back by describe-enclaves as EnclaveName. One shared
# name would not do: nitro-cli makes names unique among running enclaves (new_enclave_name appends _1, _2, ...).
NAME="t12spike-$$"
STARTED=()     # enclave ids this run started and proved (printed by run-enclave for the CID we asked for)
ATT_CID=()     # every CID this run asked run-enclave to start, recorded before the call
ATT_PRE=()     # for each attempt: the enclave ids that existed in the snapshot taken just before that run-enclave
KNOWN=" "      # CIDs whose id is already in STARTED
REFUSED=0      # a launch was refused (CID held, or the host could not be listed)
# An id this script can hand to terminate-enclave exactly as the host gave it. A NUL can't survive a shell variable (bash
# drops it, which makes a different id), newlines and tabs break the line reads below, and a leading dash reads as a flag.
ID_OK='def idok: type == "string" and length > 0 and (explode | all(. >= 32 and . != 127)) and (startswith("-") | not); '
# The id run-enclave printed, only if its output is exactly one object bound to this launch: our CID (numeric) and our
# name. The launch and cleanup both ask this, so there is one rule for trusting that output.
printed_id() {
  jq -sr --argjson c "$1" --arg n "$NAME-$1" "$ID_OK"'if length == 1 and (.[0] | type == "object" and (.EnclaveID | idok) and (.EnclaveCID | type == "number") and .EnclaveCID == $c and .EnclaveName == $n) then .[0].EnclaveID else empty end' "$OUTD/$1.out" 2>/dev/null
}
# Ownership is never inferred from a CID alone. An enclave found on an attempted CID is ours only if (a) run-enclave
# itself printed its id for that CID, or (b) it is absent from the pre-launch snapshot AND carries that launch's EnclaveName.
# Anything else is named and left running, and the script exits non-zero.
cleanup() {
  local st=$?
  trap '' INT TERM   # a second INT/TERM must not cut cleanup short
  trap - EXIT
  set +e
  local rc=0 i cid id found pre kind
  [ "$REFUSED" = 0 ] || rc=1
  for i in "${!ATT_CID[@]}"; do
    cid=${ATT_CID[$i]}
    case "$KNOWN" in *" $cid "*) continue ;; esac
    id=$(printed_id "$cid")
    if [ -n "$id" ]; then STARTED+=("$id"); continue; fi
    if found=$(enclaves); then
      pre=${ATT_PRE[$i]:-[]}   # a signal can land between recording the CID and its snapshot; the name check still applies
      # jq does the matching, on exact strings: the id reaches STARTED as the host wrote it, and anything else is only named.
      while IFS=$'\t' read -r kind id; do
        if [ "$kind" = ours ]; then STARTED+=("$id")
        else echo "enclave $id holds CID $cid but this run cannot prove it started it; NOT terminating it. Check it and stop it by hand if it is yours." >&2; rc=1; fi
      done < <(jq -r --argjson c "$cid" --argjson pre "$pre" --arg n "$NAME-$cid" "$ID_OK"'.[] | select(.EnclaveCID == $c) | .EnclaveID as $i | select(any($pre[]; . == $i) | not) | if ($i | idok) and .EnclaveName == $n then "ours\t\($i)" else "other\t\(if ($i | idok) then $i else ($i | tojson) end)" end' <<<"$found")
    else
      echo "cannot list enclaves to look for CID $cid; check it and stop it by hand" >&2; rc=1
    fi
  done
  for id in ${STARTED[@]+"${STARTED[@]}"}; do
    if ! nitro-cli terminate-enclave --enclave-id "$id" >/dev/null 2>&1; then
      echo "terminate-enclave FAILED: enclave $id is still running; stop it by hand: nitro-cli terminate-enclave --enclave-id $id" >&2; rc=1
    fi
  done
  if [ -n "${SOCAT:-}" ]; then
    kill "$SOCAT" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$SOCAT" 2>/dev/null || break; sleep 0.2; done   # never `wait`: a socat that ignores TERM would hang cleanup
    if kill -0 "$SOCAT" 2>/dev/null; then echo "socat (pid $SOCAT) is still running; kill it by hand" >&2; rc=1; fi
  fi
  rm -rf "$OUTD"
  # `return` in an EXIT trap does not change the exit status; `exit` does. Keep a failing status, else report ours.
  [ "$st" = 0 ] || exit "$st"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "== docker build"
docker build -q -f enclave/Dockerfile -t attessa/enclave-spike:t12 .
echo "== nitro-cli build-enclave (PCRs)"
nitro-cli build-enclave --docker-uri attessa/enclave-spike:t12 --output-file build/enclave-spike.eif | jq -c .Measurements
run() {
  local cid=$1 snap out id
  # Strict snapshot immediately before the launch: a CID already held (a seller may have taken it while docker and
  # build-enclave ran) is never launched onto, and a host we cannot list is never launched onto either.
  snap=$(enclaves) || { echo "refusing to start CID $cid: cannot establish the set of running enclaves"; REFUSED=1; return 1; }
  if jq -e --argjson c "$cid" 'any(.[]; .EnclaveCID == $c)' <<<"$snap" >/dev/null; then
    echo "refusing to start CID $cid: an enclave already holds it (not ours; left alone)"; REFUSED=1; return 1
  fi
  ATT_CID+=("$cid"); ATT_PRE+=("$(jq -c '[.[].EnclaveID]' <<<"$snap")")   # before the call
  nitro-cli run-enclave --eif-path build/enclave-spike.eif --cpu-count 1 --memory 1024 --enclave-cid "$cid" --enclave-name "$NAME-$cid" >"$OUTD/$cid.out" || return 1
  out=$(<"$OUTD/$cid.out")
  id=$(printed_id "$cid") && [ -n "$id" ] || { echo "cannot confirm the run-enclave response for CID $cid; cleanup will look it up"; return 1; }
  KNOWN+="$cid "; STARTED+=("$id")   # recorded at once so cleanup terminates exactly this enclave
  jq -r '"started CID \(.EnclaveCID), \(.NumberOfCPUs) CPU, \(.MemoryMiB) MiB"' <<<"$out" || true
}

echo "== first enclave (test layout: CID 18, port 5006)"
run 18
socat TCP-LISTEN:5006,bind=127.0.0.1,fork,reuseaddr VSOCK-CONNECT:18:5000 & SOCAT=$!
node scripts/t12-configure.mjs 5006 att.bin
echo "== verify, part 1"
node scripts/inspect-attestation.mjs att.bin

echo "== two more (CIDs 16, 17)"
run 16
run 17
echo "== verify, part 2: enclaves running"
FINAL=$(enclaves) || { echo "cannot list the running enclaves for the final count"; exit 1; }
COUNT=$(jq length <<<"$FINAL")
echo "$COUNT"
[ "$COUNT" = 3 ] || { echo "expected exactly 3 enclaves side by side, found $COUNT"; exit 1; }
