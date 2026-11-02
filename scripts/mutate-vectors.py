#!/usr/bin/env python3
# One-value mutants (from adversary T03 r2) of vectors/*.json, each run through
# scripts/check-vectors-oracle.py in a scratch copy (tracked files are never touched).
# A mutant SURVIVES when the oracle script exits 0 on a vector that is wrong; exit 1 if any does.
# Run from the repo root: python3 -I scripts/mutate-vectors.py
import copy, json, os, shutil, subprocess, sys, tempfile

ROOT = os.getcwd()
ORACLE = os.path.join(ROOT, "scripts/check-vectors-oracle.py")
FILES = ["origins.json", "hashes.json", "binding.json", "eip712.json", "headers.json"]
base = {f: json.load(open(os.path.join(ROOT, "vectors", f))) for f in FILES}

def keccak_str(s):
    return subprocess.run(["cast", "keccak", "0x" + s.encode().hex()], check=True, capture_output=True, text=True).stdout.strip()

def flip(h):  # change the last hex digit of a 0x value
    return h[:-1] + ("0" if h[-1] != "0" else "1")

def m_jcs_noncanonical(v):
    # Keep keys in the order the generator wrote them (not JCS) and make `expected` agree.
    c = v["hashes.json"]["inputsHash"][0]
    c["jcs"] = json.dumps(c["inputs"], separators=(",", ":"), ensure_ascii=False)
    c["expected"] = keccak_str(c["jcs"])
def m_sig_signer(v): v["eip712.json"]["signatures"][0]["signer"] = flip(v["eip712.json"]["signatures"][0]["signer"])
def m_payer_signer(v): v["headers.json"]["payerSig"]["valid"][0]["signer"] = flip(v["headers.json"]["payerSig"]["valid"][0]["signer"])
def m_payer_sig_bytes(v):
    c = v["headers.json"]["payerSig"]["valid"][0]
    c["signature"] = c["signature"][:4] + ("0" if c["signature"][4] != "0" else "1") + c["signature"][5:]
    c["header"] = f"{c['unixSeconds']}.{c['signature']}"
def m_payer_msg_case(v):
    c = v["headers.json"]["payerSig"]["valid"][0]
    c["message"] = c["message"].upper()
def m_proof_signer(v): v["headers.json"]["attestedProof"]["valid"][0]["signer"] = flip(v["headers.json"]["attestedProof"]["valid"][0]["signer"])
def m_proof_json(v):
    c = v["headers.json"]["attestedProof"]["valid"][0]; c["json"] = c["json"].replace('"agentId":"1"', '"agentId":"2"')
def m_bytes32_invalid_to_valid(v):
    h = v["headers.json"]["bytes32"]; h["valid"].append(h["invalid"].pop(0))
def m_retry_invalid_to_valid(v):
    h = v["headers.json"]["retryAfter"]; h["valid"].append(h["invalid"].pop(0))
def m_payer_invalid_dropped(v): v["headers.json"]["payerSig"]["invalid"] = []
def m_origin_normalized(v):
    c = v["origins.json"]["valid"][1]  # uppercase host and scheme
    c["normalized"] = "https://EXAMPLE.com"; c["originHash"] = keccak_str(c["normalized"]); c["bytes"] = len(c["normalized"])
def m_origin_invalid_reason(v): v["origins.json"]["invalid"][0]["reason"] = "accepted"
def m_empty_family(v): v["hashes.json"]["requestHash"] = []
def m_expected_case(v): v["hashes.json"]["responseHash"][0]["expected"] = v["hashes.json"]["responseHash"][0]["expected"].upper().replace("0X", "0x")
def m_request_hash(v): v["hashes.json"]["requestHash"][0]["expected"] = flip(v["hashes.json"]["requestHash"][0]["expected"])
def m_userdata(v): v["binding.json"]["userData"][0]["expected"] = flip(v["binding.json"]["userData"][0]["expected"])
def m_proof_digest(v): v["eip712.json"]["proof"][0]["digest"] = flip(v["eip712.json"]["proof"][0]["digest"])
def m_payer_digest(v): v["headers.json"]["payerSig"]["valid"][0]["digest"] = flip(v["headers.json"]["payerSig"]["valid"][0]["digest"])

# Added with the r2 fixes: nested-only JCS sorting, reasons and validity flags, dropped cases.
def m_jcs_top_level_only(v):
    def top(x): return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + json.dumps(x[k], separators=(",", ":"), ensure_ascii=False) for k in sorted(x)) + "}"
    c = v["hashes.json"]["inputsHash"][0]
    c["jcs"] = top(c["inputs"]); c["expected"] = keccak_str(c["jcs"])
def m_sig_reason(v): v["eip712.json"]["signatures"][4]["reason"] = "bad_v"
def m_sig_valid_flag(v): v["eip712.json"]["signatures"][4]["valid"] = True
def m_proof_invalid_reason(v): v["headers.json"]["attestedProof"]["invalid"][3]["reason"] = "base64"
def m_origin_valid_dropped(v): v["origins.json"]["valid"].pop()
def m_retry_valid_to_invalid(v):
    h = v["headers.json"]["retryAfter"]; h["invalid"].append(h["valid"].pop(0))

MUTANTS = [m for n, m in sorted(globals().items()) if n.startswith("m_")]
survivors = 0
for m in MUTANTS:
    v = copy.deepcopy(base); m(v)
    d = tempfile.mkdtemp(prefix="mutate-vectors-")
    try:
        os.mkdir(os.path.join(d, "vectors"))
        for f in FILES:
            with open(os.path.join(d, "vectors", f), "w") as fh: json.dump(v[f], fh, ensure_ascii=False, indent=2)
        r = subprocess.run([sys.executable, "-I", ORACLE], cwd=d, capture_output=True, text=True)
    finally:
        shutil.rmtree(d)
    tail = (r.stdout.strip().splitlines() or [""])[-1]
    verdict = "caught" if r.returncode else "SURVIVED"
    survivors += r.returncode == 0
    print(f"{verdict:8} {m.__name__[2:]:28} exit={r.returncode} {tail}")
print("survivors:", survivors, "of", len(MUTANTS))
sys.exit(1 if survivors else 0)
