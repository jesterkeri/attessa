#!/usr/bin/env python3
# Independent oracle for vectors/*.json (INV-18): recomputes every expected value with Foundry
# `cast` (keccak, abi-encode, hash-message), no viem and no @attessa/core. Exit 1 on any mismatch.
# Run from the repo root: python3 -I scripts/check-vectors-oracle.py
import json, subprocess, sys

def cast(*args):
    return subprocess.run(["cast", *args], check=True, capture_output=True, text=True).stdout.strip()

def keccak_hex(h):  # h: 0x-hex bytes
    return cast("keccak", h if h != "0x" else "0x")

def keccak_str(s):
    return keccak_hex("0x" + s.encode("utf-8").hex())

def enc(types, *vals):
    return cast("abi-encode", f"f({types})", *vals)

fails = 0
count = 0
def eq(name, got, want):
    global count; count += 1
    global fails
    if got.lower() != want.lower():
        fails += 1
        print(f"MISMATCH {name}: got {got} want {want}")

V = lambda f: json.load(open(f"vectors/{f}"))

# ---- eip712
e = V("eip712.json")
dom_t = keccak_str("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
pt = e["typeStrings"]["ExecutionProof"]; lt = e["typeStrings"]["Liveness"]
eq("spec type string proof", pt, "ExecutionProof(uint256 agentId,bytes32 releaseId,bytes32 requestId,bytes32 requestHash,bytes32 responseHash,bytes32 inputsHash,bytes32 paymentId,uint64 issuedAt,uint64 expiresAt)")
eq("spec type string liveness", lt, "Liveness(uint256 agentId,bytes32 releaseId,bytes32 originHash,bytes32 challenge,uint64 issuedAt)")
PT = keccak_str(pt); LT = keccak_str(lt)
eq("typehash proof", e["typehashes"]["ExecutionProof"], PT)
eq("typehash liveness", e["typehashes"]["Liveness"], LT)
def domsep(c):
    return keccak_hex(enc("bytes32,bytes32,bytes32,uint256,address", dom_t, keccak_str("AttestedExecution"), keccak_str("1"), c["chainId"], c["verifyingContract"]))
for c in e["proof"]:
    ds = domsep(c); eq(f"proof {c['name']} domsep", c["domainSeparator"], ds)
    sh = keccak_hex(enc("bytes32,uint256,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,uint64,uint64", PT, c["agentId"], c["releaseId"], c["requestId"], c["requestHash"], c["responseHash"], c["inputsHash"], c["paymentId"], c["issuedAt"], c["expiresAt"]))
    eq(f"proof {c['name']} struct", c["structHash"], sh)
    eq(f"proof {c['name']} digest", c["digest"], keccak_hex("0x1901" + ds[2:] + sh[2:]))
    eq(f"proof {c['name']} ttl", str(int(c["expiresAt"]) - int(c["issuedAt"])), "600")
for c in e["liveness"]:
    ds = domsep(c); eq(f"live {c['name']} domsep", c["domainSeparator"], ds)
    sh = keccak_hex(enc("bytes32,uint256,bytes32,bytes32,bytes32,uint64", LT, c["agentId"], c["releaseId"], c["originHash"], c["challenge"], c["issuedAt"]))
    eq(f"live {c['name']} struct", c["structHash"], sh)
    eq(f"live {c['name']} digest", c["digest"], keccak_hex("0x1901" + ds[2:] + sh[2:]))
N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141
for c in e["signatures"]:
    sig = c["signature"]
    if len(sig) != 132:
        eq(f"sig {c['name']} invalid", c["signer"], ""); continue
    r = int(sig[2:66], 16); s = int(sig[66:130], 16); v = int(sig[130:], 16)
    ok = v in (27, 28) and 0 < r < N and 0 < s <= N // 2
    eq(f"sig {c['name']} validity", str(ok), str(c["valid"]))

# ---- hashes
h = V("hashes.json")
for c in h["requestHash"]:
    pre = "0x" + "".join(ch.upper() if "a" <= ch <= "z" else ch for ch in c["method"]).encode().hex() + "00" + c["pathAndQuery"].encode().hex() + "00" + c["body"][2:]
    eq(f"requestHash {c['name']}", c["expected"], keccak_hex(pre))
for c in h["responseHash"]:
    eq(f"responseHash {c['name']}", c["expected"], keccak_hex(c["body"]))
for c in h["releaseId"]:
    for p in ("pcr0", "pcr1", "pcr2"): eq(f"release {c['name']} {p} len", str(len(c[p])), str(2 + 96))
    eq(f"releaseId {c['name']}", c["expected"], keccak_hex("0x" + c["pcr0"][2:] + c["pcr1"][2:] + c["pcr2"][2:]))
for c in h["requestId"]:
    pre = "0x" + c["asset"][2:].rjust(64, "0") + c["payer"][2:].rjust(64, "0") + c["nonce"][2:]
    eq(f"requestId {c['name']}", c["expected"], keccak_hex(pre.lower()))
for c in h["inputsHash"]:
    eq(f"inputsHash {c['name']}", c["expected"], keccak_str(c["jcs"]))

# ---- binding
b = V("binding.json")
eq("binding typehash", b["typehash"], keccak_str("AttestedExecution.SignerBinding.v1"))
for c in b["userData"]:
    ud = enc("bytes32,uint256,address,uint256,bytes32", b["typehash"], c["chainId"], c["registry"], c["agentId"], c["originHash"])
    eq(f"userData {c['name']}", c["expected"], ud)
    eq(f"userData {c['name']} len", str((len(c["expected"]) - 2) // 2), "160")
for c in b["signer"]:
    pk = c["publicKey"]; eq(f"pk {c['name']} prefix", pk[:4], "0x04")
    eq(f"signer {c['name']}", c["expected"], "0x" + keccak_hex("0x" + pk[4:])[-40:])

# ---- origins
o = V("origins.json")
for c in o["valid"]:
    eq(f"originHash {c['name']}", c["originHash"], keccak_str(c["normalized"]))
    eq(f"origin bytes {c['name']}", str(c["bytes"]), str(len(c["normalized"].encode())))
    n = len(c["normalized"].encode())
    if not (9 <= n <= 267): print(f"MISMATCH origin length {c['name']} {n}"); fails += 1

# ---- headers: payer sig digests (EIP-191)
hd = V("headers.json")
for c in hd["payerSig"]["valid"]:
    msg = f"attested-exec:results:{c['requestId'].lower()}:{c['unixSeconds']}"
    eq(f"payer msg {c['name']}", c["message"], msg)
    eq(f"payer digest {c['name']}", c["digest"], cast("hash-message", msg))
    eq(f"payer header {c['name']}", c["header"], f"{c['unixSeconds']}.{c['signature']}")

print("checks:", count, "fails:", fails)
sys.exit(1 if fails else 0)
