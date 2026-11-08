#!/usr/bin/env bash
# Rehearsal phase 0: a local anvil fork of Celo mainnet. Read-only use of Forno (fork source only).
# Usage: scripts/rehearse/phase0-fork.sh [port]   (default 18545). Writes pid to $REHEARSE_DIR/anvil.pid
set -euo pipefail
PORT="${1:-18545}"
DIR="${REHEARSE_DIR:-/tmp/attessa-rehearse}"
mkdir -p "$DIR"; chmod 700 "$DIR"
# Realistic per-transaction gas cap (EIP-7825, 2^24). Block gas limit comes from the fork (Celo: 30,000,000).
nohup anvil --fork-url https://forno.celo.org --port "$PORT" --host 127.0.0.1 --chain-id 42220 \
  --hardfork osaka --enable-tx-gas-limit --silent > "$DIR/anvil.log" 2>&1 &
echo $! > "$DIR/anvil.pid"
for i in $(seq 1 100); do
  if node -e "fetch('http://127.0.0.1:$PORT',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'anvil_nodeInfo',params:[]})}).then(r=>r.json()).then(j=>{if(!j.result)process.exit(1);console.log(JSON.stringify(j.result))}).catch(()=>process.exit(1))" 2>/dev/null; then exit 0; fi
  sleep 0.3
done
echo "anvil did not start; see $DIR/anvil.log" >&2; exit 1
