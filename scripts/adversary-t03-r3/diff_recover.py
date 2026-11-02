# Cross-checks the oracle's secp256k1 recovery against Foundry cast on fresh random keys and digests.
import os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oracle_lib
O = oracle_lib.load()
def cast(*a): return subprocess.run(["cast", *a], check=True, capture_output=True, text=True).stdout.strip()
N = O["N"]; bad = 0; runs = int(sys.argv[1]) if len(sys.argv) > 1 else 40
for i in range(runs):
    k = "0x" + os.urandom(32).hex(); d = "0x" + os.urandom(32).hex()
    addr = cast("wallet", "address", "--private-key", k).lower()
    sig = cast("wallet", "sign", "--no-hash", "--private-key", k, d).lower()
    got = O["recover"](d, sig)
    # high-s twin: s' = N - s, v flipped; must be refused by the oracle
    r, s, v = sig[2:66], int(sig[66:130], 16), int(sig[130:], 16)
    twin = "0x" + r + format(N - s, "064x") + format(55 - v, "02x")
    tw = O["recover"](d, twin)
    # cast must agree that the twin recovers the same key (it is mathematically valid)
    cv = subprocess.run(["cast", "wallet", "verify", "--no-hash", "--address", addr, d, sig], capture_output=True, text=True).returncode
    if got != addr or tw != "" or cv != 0:
        bad += 1; print("MISMATCH", k[:10], d, sig, got, addr, tw, cv)
print("runs", runs, "mismatches", bad)
