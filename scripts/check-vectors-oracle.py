#!/usr/bin/env python3
# Independent oracle for vectors/*.json (INV-18). No viem and no @attessa/core: hashes and ABI
# encodings come from Foundry `cast`; everything else (RFC 8785 JCS, origin normalisation, the
# SPEC §2.5 header grammars, secp256k1 recovery, family sizes) is recomputed here from the raw
# inputs with the Python standard library, UTS-46 from the Unicode files vendored in scripts/data/.
# Every compare is exact, case included. Exit 1 on any mismatch.
# Run from the repo root: python3 -I scripts/check-vectors-oracle.py
import base64, binascii, bisect, hashlib, ipaddress, json, os, struct, subprocess, sys, unicodedata
from decimal import Decimal

def cast(*args):
    return subprocess.run(["cast", *args], check=True, capture_output=True, text=True).stdout.strip()

def keccak_hex(h):  # h: 0x-hex bytes
    return cast("keccak", h)

def keccak_str(s):
    return keccak_hex("0x" + s.encode("utf-8").hex())

def enc(types, *vals):
    return cast("abi-encode", f"f({types})", *vals)

fails = 0
count = 0
def eq(name, got, want):
    global count, fails
    count += 1
    if type(got) is not type(want) or got != want:
        fails += 1
        print(f"MISMATCH {name}: got {got!r} want {want!r}")

def ok(name, cond, detail=""):
    eq(name + (f" ({detail})" if detail else ""), bool(cond), True)

V = lambda f: json.load(open(f"vectors/{f}", encoding="utf-8"))

# ---- committed family sizes. A family may grow, never shrink or vanish.
MIN = {
    ("origins.json", "valid"): 17, ("origins.json", "invalid"): 17,
    ("hashes.json", "requestHash"): 6, ("hashes.json", "responseHash"): 3, ("hashes.json", "inputsHash"): 6,
    ("hashes.json", "releaseId"): 3, ("hashes.json", "requestId"): 2,
    ("binding.json", "userData"): 6, ("binding.json", "signer"): 4,
    ("eip712.json", "proof"): 3, ("eip712.json", "liveness"): 3, ("eip712.json", "signatures"): 9,
    ("headers.json", "bytes32.valid"): 2, ("headers.json", "bytes32.invalid"): 7,
    ("headers.json", "retryAfter.valid"): 3, ("headers.json", "retryAfter.invalid"): 4,
    ("headers.json", "payerSig.valid"): 2, ("headers.json", "payerSig.invalid"): 7,
    ("headers.json", "attestedProof.valid"): 3, ("headers.json", "attestedProof.invalid"): 13,
}
FILE_MIN = 10  # TASKS T03: at least 10 cases in each vectors file

def family(doc, path):
    x = doc
    for p in path.split("."):
        x = x.get(p) if isinstance(x, dict) else None
    return x if isinstance(x, list) else []

def check_sizes(docs):
    per_file = {}
    for (f, path), n in MIN.items():
        fam = family(docs[f], path)
        ok(f"{f} {path} has >= {n} cases", len(fam) >= n, f"has {len(fam)}")
        names = [c.get("name") for c in fam if isinstance(c, dict)]
        ok(f"{f} {path} names unique", len(names) == len(set(names)) == len(fam))
        per_file[f] = per_file.get(f, 0) + len(fam)
    for f, n in per_file.items():
        ok(f"{f} has >= {FILE_MIN} cases", n >= FILE_MIN, f"has {n}")

# ---- grammars (SPEC §2, §2.3, §2.5), written as parsers rather than regexes
HEX = set("0123456789abcdef")
DEC = set("0123456789")
def is_hex(v, nbytes=None):
    return isinstance(v, str) and v[:2] == "0x" and set(v[2:]) <= HEX and len(v) % 2 == 0 and (nbytes is None or len(v) == 2 + 2 * nbytes)
def is_bytes32(v): return is_hex(v, 32)
def is_address(v): return is_hex(v, 20)
def is_sig65(v): return is_hex(v, 65)
def is_decimal(v):  # canonical decimal: digits only, no sign, no leading zero
    return isinstance(v, str) and v != "" and set(v) <= DEC and (v == "0" or v[0] != "0")
def is_uint(v, bits):
    return is_decimal(v) and int(v) < 2 ** bits
def is_seconds(v):  # Retry-After and the payer-sig time: whole seconds
    return is_decimal(v)
def parse_payer_sig(h):  # <unixSeconds>.<0x65-byte-hex>, or None
    if not isinstance(h, str) or h.count(".") != 1: return None
    t, sig = h.split(".")
    return (t, sig) if is_seconds(t) and int(t) <= 2 ** 53 - 1 and is_sig65(sig) else None

# ---- RFC 8785 JCS, from the RFC: ECMAScript number serialisation, minimal string escaping,
# object members sorted by UTF-16 code units at every depth.
def es_number(x):
    x = float(x)
    if x != x or x in (float("inf"), float("-inf")): raise ValueError("JCS: non-finite number")
    if x == 0: return "0"
    if x < 0: return "-" + es_number(-x)
    _, digits, exp = Decimal(repr(x)).as_tuple()  # repr is the shortest round-trip digit string
    s = "".join(map(str, digits)).rstrip("0")
    e = exp + (len(digits) - len(s))
    k = len(s); n = e + k
    if k <= n <= 21: return s + "0" * (n - k)
    if 0 < n <= 21: return s[:n] + "." + s[n:]
    if -6 < n <= 0: return "0." + "0" * (-n) + s
    m = s if k == 1 else s[0] + "." + s[1:]
    return f"{m}e{'+' if n - 1 >= 0 else '-'}{abs(n - 1)}"

SHORT = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}
def jcs_str(s):
    out = []
    for ch in s:
        o = ord(ch)
        if 0xD800 <= o <= 0xDFFF: raise ValueError("JCS: lone surrogate")
        out.append(SHORT[ch] if ch in SHORT else f"\\u{o:04x}" if o < 0x20 else ch)
    return '"' + "".join(out) + '"'

def jcs(v):
    if v is None: return "null"
    if v is True: return "true"
    if v is False: return "false"
    if isinstance(v, (int, float)): return es_number(v)
    if isinstance(v, str): return jcs_str(v)
    if isinstance(v, list): return "[" + ",".join(jcs(x) for x in v) + "]"
    if isinstance(v, dict):
        keys = sorted(v, key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(jcs_str(k) + ":" + jcs(v[k]) for k in keys) + "}"
    raise TypeError(f"JCS: unsupported {type(v)}")

# Self-check against RFC 8785 Appendix B (IEEE 754 bits -> text) and a nested case written by hand.
RFC8785_B = [
    ("0000000000000000", "0"), ("8000000000000000", "0"), ("0000000000000001", "5e-324"),
    ("8000000000000001", "-5e-324"), ("7fefffffffffffff", "1.7976931348623157e+308"),
    ("ffefffffffffffff", "-1.7976931348623157e+308"), ("4340000000000000", "9007199254740992"),
    ("c340000000000000", "-9007199254740992"), ("4430000000000000", "295147905179352830000"),
    ("44b52d02c7e14af5", "9.999999999999997e+22"), ("44b52d02c7e14af6", "1e+23"),
    ("44b52d02c7e14af7", "1.0000000000000001e+23"), ("444b1ae4d6e2ef4e", "999999999999999700000"),
    ("444b1ae4d6e2ef4f", "999999999999999900000"), ("444b1ae4d6e2ef50", "1e+21"),
    ("3eb0c6f7a0b5ed8c", "9.999999999999997e-7"), ("3eb0c6f7a0b5ed8d", "0.000001"),
    ("41b3de4355555553", "333333333.3333332"), ("41b3de4355555554", "333333333.33333325"),
    ("41b3de4355555555", "333333333.3333333"), ("41b3de4355555556", "333333333.3333334"),
    ("41b3de4355555557", "333333333.33333343"), ("becbf647612f3696", "-0.0000033333333333333333"),
    ("43143ff3c1cb0959", "1424953923781206.2"),
]
for bits, text in RFC8785_B:
    eq(f"oracle self-check es_number {bits}", es_number(struct.unpack(">d", bytes.fromhex(bits))[0]), text)
eq("oracle self-check nested jcs",
   jcs({"z": [{"d": "4", "c": "3"}, True, None], "p": {"b": 2.5, "a": {"\u20ac": 1, "\r": [], "1": {}}}}),
   '{"p":{"a":{"\\r":[],"1":{},"\u20ac":1},"b":2.5},"z":[{"c":"3","d":"4"},true,null]}')

# ---- secp256k1 public-key recovery (SEC 1 §4.1.6), so a vector's `signer` is checked as the key
# that actually signed. Verifier rules from SPEC §2.3: 65 bytes r‖s‖v, v in {27,28}, low s.
P = 2 ** 256 - 2 ** 32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)
def ec_add(a, b):
    if a is None: return b
    if b is None: return a
    if a[0] == b[0] and (a[1] + b[1]) % P == 0: return None
    lam = (3 * a[0] * a[0] * pow(2 * a[1], -1, P)) if a == b else ((b[1] - a[1]) * pow(b[0] - a[0], -1, P))
    x = (lam * lam - a[0] - b[0]) % P
    return (x, (lam * (a[0] - x) - a[1]) % P)
def ec_mul(k, pt):
    out = None
    while k:
        if k & 1: out = ec_add(out, pt)
        pt = ec_add(pt, pt); k >>= 1
    return out
def address_of(pt):
    return "0x" + keccak_hex("0x" + pt[0].to_bytes(32, "big").hex() + pt[1].to_bytes(32, "big").hex())[-40:]

def sig_reason(sig):
    if not is_sig65(sig): return "bad_length"
    r = int(sig[2:66], 16); s = int(sig[66:130], 16); v = int(sig[130:], 16)
    if v not in (27, 28): return "bad_v"
    if r == 0: return "zero_r"
    if not r < N: return "bad_r"
    if s == 0: return "zero_s"
    if s > N // 2: return "high_s"
    return "ok"

def recover(digest, sig):  # -> lowercase address, or "" when the signature is not acceptable
    if sig_reason(sig) != "ok" or not is_bytes32(digest): return ""
    r = int(sig[2:66], 16); s = int(sig[66:130], 16); odd = int(sig[130:], 16) - 27
    alpha = (pow(r, 3, P) + 7) % P
    y = pow(alpha, (P + 1) // 4, P)
    if y * y % P != alpha: return ""
    if y & 1 != odd: y = P - y
    e = int(digest[2:], 16)
    rinv = pow(r, -1, N)
    q = ec_add(ec_mul(s * rinv % N, (r, y)), ec_mul((-e * rinv) % N, G))
    return "" if q is None else address_of(q)

eq("oracle self-check 1*G address", address_of(ec_mul(1, G)), "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf")

# ---- origin normalisation (SPEC §2.1): WHATWG URL parsing for special schemes and UTS-46
# non-transitional ToASCII with CheckJoiners and CheckBidi, implemented from the standards.
# Returns ("ok", normalized) or ("err", reason).
DEFAULT_PORT = {"https": 443, "http": 80, "ws": 80, "wss": 443, "ftp": 21}
FORBIDDEN_HOST = set("\x00\t\n\r #/:<>?@[\\]^|%\x7f") | {chr(c) for c in range(0x20)}
class Fail(Exception): pass

# UTS-46 at Unicode 16.0.0, the version tr46 5.1.1 (whatwg-url 14.2.0's) is generated from. Python's
# unicodedata is older (15.0), so the IDNA status/mapping, general category, combining class, bidi
# class, NFC and joining type all come from Unicode's own files, vendored with their sha256.
UCD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "unicode-16.0.0")
UCD_SHA256 = {
    "IdnaMappingTable.txt": "6db2ef4ed35f3b3de74ebc2e00404a9607f76d499f576b8d4043cf14f1ed175c",
    "UnicodeData.txt": "ff58e5823bd095166564a006e47d111130813dcf8bf234ef79fa51a870edb48f",
    "CompositionExclusions.txt": "89e83cf9cc8bef6c1f8bf77e42cf6f0341dfa42e66261f4dbe9b492e7a23c8ee",
    "DerivedJoiningType.txt": "6bd08b97da66b70ccfdab105a352de2984e02625239ec5695422c99b33d854f0",
}
def ucd_rows(name):  # data lines of a UCD file as stripped fields; exits on a hash mismatch
    raw = open(os.path.join(UCD_DIR, name), "rb").read()
    if hashlib.sha256(raw).hexdigest() != UCD_SHA256[name]: sys.exit(f"{name}: sha256 mismatch")
    for line in raw.decode("utf-8").splitlines():
        f = [x.strip() for x in line.split("#")[0].split(";")]
        if f[0]: yield f
def cp_range(r):  # "0041" or "0041..005A"
    a, _, b = r.partition("..")
    return int(a, 16), int(b or a, 16)

IDNA_START, IDNA_ROWS = [], []  # sorted ranges: (end, status, mapping)
for f in ucd_rows("IdnaMappingTable.txt"):
    a, b = cp_range(f[0])
    IDNA_START.append(a)
    IDNA_ROWS.append((b, f[1], "".join(chr(int(x, 16)) for x in f[2].split()) if len(f) > 2 else ""))
def idna(ch):  # -> (status, mapping); a code point outside every range is disallowed
    i = bisect.bisect_right(IDNA_START, ord(ch)) - 1
    return IDNA_ROWS[i][1:] if i >= 0 and ord(ch) <= IDNA_ROWS[i][0] else ("disallowed", "")

UCD, UCD_RANGES, DECOMP = {}, [], {}  # cp -> (gc, ccc, bidi); First/Last blocks; canonical decompositions
for f in ucd_rows("UnicodeData.txt"):
    cp, props = int(f[0], 16), (f[2], int(f[3]), f[4])
    if f[1].endswith(", Last>"): UCD_RANGES.append((UCD_RANGES.pop()[0], cp, props))
    elif f[1].endswith(", First>"): UCD_RANGES.append((cp, cp, props))
    else: UCD[cp] = props
    if f[5] and not f[5].startswith("<"): DECOMP[cp] = [int(x, 16) for x in f[5].split()]
def ucd(cp):  # unassigned: Cn, ccc 0; its IDNA status is disallowed, so its bidi class never decides
    return UCD.get(cp) or next((p for a, b, p in UCD_RANGES if a <= cp <= b), ("Cn", 0, "L"))
ccc = lambda cp: ucd(cp)[1]
bidi_class = lambda ch: ucd(ord(ch))[2]
JOINING = [(*cp_range(f[0]), f[1]) for f in ucd_rows("DerivedJoiningType.txt")]
def joining_type(ch):
    return next((t for a, b, t in JOINING if a <= ord(ch) <= b), "U")

# NFC (UAX #15) from the same data. Full_Composition_Exclusion = the listed exclusions, singletons and
# non-starter decompositions.
EXCLUDED = {cp_range(f[0])[0] for f in ucd_rows("CompositionExclusions.txt")}
COMPOSE = {tuple(d): cp for cp, d in DECOMP.items()
           if len(d) == 2 and cp not in EXCLUDED and ccc(cp) == 0 and ccc(d[0]) == 0}
SB, LB, VB, TB, LC, VC, TC = 0xAC00, 0x1100, 0x1161, 0x11A7, 19, 21, 28
def nfd_cps(cp):
    if SB <= cp < SB + LC * VC * TC:
        s = cp - SB
        return [LB + s // (VC * TC), VB + s % (VC * TC) // TC] + ([TB + s % TC] if s % TC else [])
    return [x for d in DECOMP[cp] for x in nfd_cps(d)] if cp in DECOMP else [cp]
def compose_pair(a, b):
    if LB <= a < LB + LC and VB <= b < VB + VC: return SB + ((a - LB) * VC + b - VB) * TC
    if SB <= a < SB + LC * VC * TC and (a - SB) % TC == 0 and TB < b < TB + TC: return a + b - TB
    return COMPOSE.get((a, b))
def nfc(s):
    d = [x for ch in s for x in nfd_cps(ord(ch))]
    for i in range(1, len(d)):  # canonical ordering: stable insertion sort of each non-starter run
        j = i
        while j > 0 and 0 < ccc(d[j]) < ccc(d[j - 1]):
            d[j - 1], d[j] = d[j], d[j - 1]; j -= 1
    out, si, last = [], None, None  # si: index of the last starter; last: ccc of the last char after it
    for cp in d:
        c = ccc(cp)
        if si is not None and (last is None or 0 < last < c):  # not blocked from the starter
            p = compose_pair(out[si], cp)
            if p is not None:
                out[si] = p; continue
        if c == 0: si, last = len(out), None
        else: last = c
        out.append(cp)
    return "".join(map(chr, out))
ok("oracle self-check NFC matches Python's on every Unicode 15 canonical decomposition",
   all(nfc(unicodedata.normalize("NFD", chr(c)) + "́") == unicodedata.normalize("NFC", chr(c) + "́")
       for c in range(0x110000) if unicodedata.decomposition(chr(c))[:1] not in ("", "<")))

def uts46_label_valid(label, bidi):  # UTS-46 §4.1 validity criteria, non-transitional, CheckHyphens off
    if label == "": return True
    if nfc(label) != label or label.startswith("xn--") or "." in label: return False
    if ucd(ord(label[0]))[0].startswith("M"): return False
    if any(idna(ch)[0] not in ("valid", "deviation") for ch in label): return False
    for i, ch in enumerate(label):  # CheckJoiners: RFC 5892 Appendix A.1 and A.2
        if ch not in "‌‍" or (i > 0 and ccc(ord(label[i - 1])) == 9): continue
        if ch == "‍": return False
        j, k = i - 1, i + 1  # ZWNJ: (L|D) T* ZWNJ T* (R|D)
        while j >= 0 and joining_type(label[j]) == "T": j -= 1
        while k < len(label) and joining_type(label[k]) == "T": k += 1
        if not (j >= 0 and joining_type(label[j]) in ("L", "D") and k < len(label) and joining_type(label[k]) in ("R", "D")):
            return False
    return not bidi or bidi_rule(label)

def bidi_rule(label):  # RFC 5893 §2
    cls = [bidi_class(c) for c in label]
    if cls[0] not in ("L", "R", "AL"): return False
    core = cls[:]
    while core and core[-1] == "NSM": core.pop()
    if cls[0] in ("R", "AL"):
        if any(c not in ("R", "AL", "AN", "EN", "ES", "CS", "ET", "ON", "BN", "NSM") for c in cls): return False
        if not core or core[-1] not in ("R", "AL", "EN", "AN"): return False
        if "EN" in cls and "AN" in cls: return False
    else:
        if any(c not in ("L", "EN", "ES", "CS", "ET", "ON", "BN", "NSM") for c in cls): return False
        if not core or core[-1] not in ("L", "EN"): return False
    return True

def domain_to_ascii(host):  # WHATWG "domain to ASCII", beStrict false: UTS-46 ToASCII (§4, §4.2)
    mapped = ""
    for ch in host:  # 1. Map (disallowed is kept and fails validity below)
        status, to = idna(ch)
        mapped += to if status == "mapped" else "" if status == "ignored" else ch
    labels = nfc(mapped).split(".")  # 2. Normalize, 3. Break
    for i, label in enumerate(labels):  # 4. Convert
        if label.startswith("xn--"):
            if not label.isascii(): raise Fail
            try: labels[i] = label[4:].encode("ascii").decode("punycode")
            except Exception: raise Fail
            if labels[i] == "" or labels[i].isascii(): raise Fail
    bidi = any(bidi_class(c) in ("R", "AL", "AN") for l in labels for c in l)  # a Bidi domain name
    if not all(uts46_label_valid(l, bidi) for l in labels): raise Fail  # 4. Validate
    out = ".".join(l if l.isascii() else "xn--" + l.encode("punycode").decode("ascii") for l in labels)
    if out == "": raise Fail
    return out

def ipv4_number(part):
    radix = 10
    if part[:2] in ("0x", "0X"): radix, part = 16, part[2:]
    elif len(part) > 1 and part[0] == "0": radix, part = 8, part[1:]
    if part == "": return 0
    digits = {10: "0123456789", 16: "0123456789abcdefABCDEF", 8: "01234567"}[radix]
    if not set(part) <= set(digits): raise Fail
    return int(part, radix)

def ends_in_number(host):
    parts = host.split(".")
    if parts[-1] == "" and len(parts) > 1: parts.pop()
    last = parts[-1]
    if last != "" and set(last) <= DEC: return True
    try:
        if last[:2] in ("0x", "0X"): ipv4_number(last); return True
    except Fail: pass
    return False

def parse_ipv4(host):
    parts = host.split(".")
    if parts[-1] == "" and len(parts) > 1: parts.pop()
    if len(parts) > 4 or "" in parts: raise Fail
    nums = [ipv4_number(p) for p in parts]
    if any(n > 255 for n in nums[:-1]) or nums[-1] >= 256 ** (5 - len(nums)): raise Fail
    v = nums[-1] + sum(n * 256 ** (3 - i) for i, n in enumerate(nums[:-1]))
    return ".".join(str((v >> s) & 255) for s in (24, 16, 8, 0))

def serialize_ipv6(text):
    pieces = [int(x, 16) for x in ipaddress.IPv6Address(text).exploded.split(":")]
    best, start = (0, -1), -1
    for i in range(9):
        if i < 8 and pieces[i] == 0:
            if start < 0: start = i
        elif start >= 0:
            if i - start > best[0]: best = (i - start, start)
            start = -1
    out, i = "", 0
    while i < 8:
        if best[0] >= 2 and i == best[1]:
            out += "::"; i += best[0]; continue
        out += ("" if out == "" or out.endswith("::") else ":") + format(pieces[i], "x"); i += 1
    return "[" + out + "]"

def percent_decode(s):
    out, i = bytearray(), 0
    raw = s.encode("utf-8")
    while i < len(raw):
        pair = raw[i + 1:i + 3]
        if raw[i] == 0x25 and len(pair) == 2 and all(chr(c) in "0123456789abcdefABCDEF" for c in pair):
            out.append(int(raw[i + 1:i + 3], 16)); i += 3
        else:
            out.append(raw[i]); i += 1
    return out.decode("utf-8", errors="replace")

def whatwg_origin(inp):  # -> (scheme, userinfo?, host, kind, port or None)
    s = inp.strip("".join(chr(c) for c in range(0x21))).replace("\t", "").replace("\n", "").replace("\r", "")
    i = 0
    if not (s[:1].isascii() and s[:1].isalpha()): raise Fail
    while i < len(s) and s[i].isascii() and (s[i].isalnum() or s[i] in "+-."): i += 1
    if i >= len(s) or s[i] != ":": raise Fail
    scheme, rest = s[:i].lower(), s[i + 1:]
    if scheme not in DEFAULT_PORT: return scheme, False, None, None, None  # not special: no host to judge
    rest = rest.lstrip("/\\")
    end = min([rest.find(c) for c in "/\\?#" if c in rest] or [len(rest)])
    auth = rest[:end]
    userinfo = "@" in auth
    hostport = auth.rsplit("@", 1)[-1]
    if hostport.startswith("["):
        close = hostport.find("]")
        if close < 0: raise Fail
        try: host = serialize_ipv6(hostport[1:close])
        except ValueError: raise Fail
        kind, tail = "ipv6", hostport[close + 1:]
        if tail and not tail.startswith(":"): raise Fail
        port_s = tail[1:] if tail else None
    else:
        h, _, port_s = hostport.partition(":")
        if not _: port_s = None
        if h == "": raise Fail
        host = domain_to_ascii(percent_decode(h))
        if set(host) & FORBIDDEN_HOST: raise Fail
        kind = "domain"
        if ends_in_number(host): host, kind = parse_ipv4(host), "ipv4"
    port = None
    if port_s:
        if not set(port_s) <= DEC or int(port_s) > 65535: raise Fail
        port = None if int(port_s) == DEFAULT_PORT[scheme] else int(port_s)
    return scheme, userinfo, host, kind, port

def origin_oracle(inp, local):
    try:
        scheme, userinfo, host, kind, port = whatwg_origin(inp)
    except Fail:
        return ("err", "invalid_url")
    local_http = local and scheme == "http" and host == "localhost" and port is not None
    if scheme != "https" and not local_http: return ("err", "not_https")
    if userinfo: return ("err", "userinfo")
    if host.endswith("."): return ("err", "trailing_dot")
    if not local and kind in ("ipv4", "ipv6"): return ("err", "ip_literal")
    out = f"{scheme}://{host}" + (f":{port}" if port is not None else "")
    if not 9 <= len(out.encode("utf-8")) <= 267: return ("err", "length")
    return ("ok", out)

# ---- X-Attested-Proof (SPEC §2.5): base64 of JCS {"proof":{...strings...},"signature","signer"}.
# Returns (reason, obj, text); reason "ok" when the header is well formed.
PROOF_FIELDS = {"agentId": 256, "releaseId": "b32", "requestId": "b32", "requestHash": "b32", "responseHash": "b32",
                "inputsHash": "b32", "paymentId": "b32", "issuedAt": 64, "expiresAt": 64}
B64 = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")
def parse_attested_proof(h):
    if not isinstance(h, str) or h == "" or len(h) % 4 or not set(h.rstrip("=")) <= B64 or len(h) - len(h.rstrip("=")) > 2:
        return ("base64", None, None)
    try: raw = base64.b64decode(h, validate=True)
    except binascii.Error: return ("base64", None, None)
    if base64.b64encode(raw).decode("ascii") != h: return ("base64", None, None)  # non-zero padding bits
    try:
        text = raw.decode("utf-8")
        obj = json.loads(text)
    except (UnicodeDecodeError, ValueError):
        return ("not_jcs", None, None)
    if not isinstance(obj, dict): return ("field_grammar", None, None)
    try:
        if jcs(obj) != text: return ("not_jcs", None, None)
    except (ValueError, TypeError):
        return ("not_jcs", None, None)
    top = {"proof", "signature", "signer"}
    if set(obj) - top: return ("unknown_field", None, None)
    if top - set(obj): return ("missing_field", None, None)
    pr = obj["proof"]
    if not isinstance(pr, dict): return ("field_grammar", None, None)
    if set(pr) - set(PROOF_FIELDS): return ("unknown_field", None, None)
    if set(PROOF_FIELDS) - set(pr): return ("missing_field", None, None)
    for k, g in PROOF_FIELDS.items():
        if not (is_bytes32(pr[k]) if g == "b32" else is_uint(pr[k], g)): return ("field_grammar", None, None)
    if not is_sig65(obj["signature"]) or not is_address(obj["signer"]): return ("field_grammar", None, None)
    return ("ok", obj, text)

docs = {f: V(f) for f in ("origins.json", "hashes.json", "binding.json", "eip712.json", "headers.json")}
check_sizes(docs)

# ---- eip712
e = docs["eip712.json"]
dom_t = keccak_str("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
pt = e["typeStrings"]["ExecutionProof"]; lt = e["typeStrings"]["Liveness"]
eq("spec type string proof", pt, "ExecutionProof(uint256 agentId,bytes32 releaseId,bytes32 requestId,bytes32 requestHash,bytes32 responseHash,bytes32 inputsHash,bytes32 paymentId,uint64 issuedAt,uint64 expiresAt)")
eq("spec type string liveness", lt, "Liveness(uint256 agentId,bytes32 releaseId,bytes32 originHash,bytes32 challenge,uint64 issuedAt)")
eq("domain", e["domain"], {"name": "AttestedExecution", "version": "1"})
PT = keccak_str(pt); LT = keccak_str(lt)
eq("typehash proof", e["typehashes"]["ExecutionProof"], PT)
eq("typehash liveness", e["typehashes"]["Liveness"], LT)
def domsep(chain_id, contract):
    return keccak_hex(enc("bytes32,bytes32,bytes32,uint256,address", dom_t, keccak_str("AttestedExecution"), keccak_str("1"), chain_id, contract))
def proof_digest(chain_id, contract, p):
    sh = keccak_hex(enc("bytes32,uint256,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,uint64,uint64", PT, p["agentId"], p["releaseId"], p["requestId"], p["requestHash"], p["responseHash"], p["inputsHash"], p["paymentId"], p["issuedAt"], p["expiresAt"]))
    return sh, keccak_hex("0x1901" + domsep(chain_id, contract)[2:] + sh[2:])
def proof_grammar(name, c, fields):
    ok(f"{name} chainId grammar", is_uint(c["chainId"], 256))
    ok(f"{name} verifyingContract grammar", is_address(c["verifyingContract"]))
    for k in fields:
        ok(f"{name} {k} grammar", is_bytes32(c[k]) if PROOF_FIELDS.get(k, "b32") == "b32" else is_uint(c[k], PROOF_FIELDS[k]))
digests = set()
for c in e["proof"]:
    n = f"proof {c['name']}"
    proof_grammar(n, c, PROOF_FIELDS)
    eq(f"{n} domsep", c["domainSeparator"], domsep(c["chainId"], c["verifyingContract"]))
    sh, dg = proof_digest(c["chainId"], c["verifyingContract"], c)
    eq(f"{n} struct", c["structHash"], sh)
    eq(f"{n} digest", c["digest"], dg)
    eq(f"{n} ttl", int(c["expiresAt"]) - int(c["issuedAt"]), 600)
    digests.add(dg)
for c in e["liveness"]:
    n = f"live {c['name']}"
    proof_grammar(n, c, ["agentId", "releaseId", "originHash", "challenge", "issuedAt"])
    ds = domsep(c["chainId"], c["verifyingContract"])
    eq(f"{n} domsep", c["domainSeparator"], ds)
    sh = keccak_hex(enc("bytes32,uint256,bytes32,bytes32,bytes32,uint64", LT, c["agentId"], c["releaseId"], c["originHash"], c["challenge"], c["issuedAt"]))
    eq(f"{n} struct", c["structHash"], sh)
    eq(f"{n} digest", c["digest"], keccak_hex("0x1901" + ds[2:] + sh[2:]))
    digests.add(c["digest"])
reasons_seen = set()
for c in e["signatures"]:
    n = f"sig {c['name']}"
    ok(f"{n} digest is a proof or liveness digest above", c["digest"] in digests)
    reason = sig_reason(c["signature"])
    signer = recover(c["digest"], c["signature"])
    eq(f"{n} reason", c["reason"], reason)
    eq(f"{n} validity", c["valid"], reason == "ok" and signer != "")
    eq(f"{n} signer is the recovered key", c["signer"], signer)
    reasons_seen.add(reason)
for r in ("ok", "high_s", "bad_v", "zero_r", "bad_length"):
    ok(f"signatures cover reason {r}", r in reasons_seen)

# ---- hashes
h = docs["hashes.json"]
for c in h["requestHash"]:
    n = f"requestHash {c['name']}"
    ok(f"{n} body is 0x hex", is_hex(c["body"]))
    ok(f"{n} pathAndQuery starts with /", c["pathAndQuery"].startswith("/"))
    method = "".join(ch.upper() if "a" <= ch <= "z" else ch for ch in c["method"])
    pre = "0x" + method.encode().hex() + "00" + c["pathAndQuery"].encode().hex() + "00" + c["body"][2:]
    eq(n, c["expected"], keccak_hex(pre))
for c in h["responseHash"]:
    ok(f"responseHash {c['name']} body is 0x hex", is_hex(c["body"]))
    eq(f"responseHash {c['name']}", c["expected"], keccak_hex(c["body"]))
for c in h["releaseId"]:
    for p in ("pcr0", "pcr1", "pcr2"): ok(f"release {c['name']} {p} is 48 bytes", is_hex(c[p], 48))
    eq(f"releaseId {c['name']}", c["expected"], keccak_hex("0x" + c["pcr0"][2:] + c["pcr1"][2:] + c["pcr2"][2:]))
for c in h["requestId"]:
    ok(f"requestId {c['name']} grammar", is_address(c["asset"]) and is_address(c["payer"]) and is_bytes32(c["nonce"]))
    pre = "0x" + c["asset"][2:].rjust(64, "0") + c["payer"][2:].rjust(64, "0") + c["nonce"][2:]
    eq(f"requestId {c['name']}", c["expected"], keccak_hex(pre))
nested = False
for c in h["inputsHash"]:
    n = f"inputsHash {c['name']}"
    want = jcs(c["inputs"])  # recomputed from the raw inputs, not taken from the vector
    eq(f"{n} jcs", c["jcs"], want)
    eq(n, c["expected"], keccak_str(want))
    nested |= isinstance(c["inputs"], dict) and any(isinstance(x, (dict, list)) for x in c["inputs"].values())
ok("inputsHash covers nested objects", nested)

# ---- binding
b = docs["binding.json"]
eq("binding typehash preimage", b["typehashPreimage"], "AttestedExecution.SignerBinding.v1")
eq("binding typehash", b["typehash"], keccak_str("AttestedExecution.SignerBinding.v1"))
for c in b["userData"]:
    n = f"userData {c['name']}"
    ok(f"{n} grammar", is_uint(c["chainId"], 256) and is_address(c["registry"]) and is_uint(c["agentId"], 256) and is_bytes32(c["originHash"]))
    ud = enc("bytes32,uint256,address,uint256,bytes32", b["typehash"], c["chainId"], c["registry"], c["agentId"], c["originHash"])
    eq(n, c["expected"], ud)
    eq(f"{n} len", (len(c["expected"]) - 2) // 2, 160)
for c in b["signer"]:
    pk = c["publicKey"]; n = f"signer {c['name']}"
    ok(f"{n} is a 65-byte 0x04 key", is_hex(pk, 65) and pk[:4] == "0x04")
    x, y = int(pk[4:68], 16), int(pk[68:], 16)
    ok(f"{n} on secp256k1", (y * y - x * x * x - 7) % P == 0)
    eq(n, c["expected"], address_of((x, y)))

# ---- origins
o = docs["origins.json"]
for c in o["valid"]:
    n = f"origin {c['name']}"
    eq(f"{n} normalized", ("ok", c["normalized"]), origin_oracle(c["input"], c["local"] is True))
    eq(f"{n} originHash", c["originHash"], keccak_str(c["normalized"]))
    eq(f"{n} bytes", c["bytes"], len(c["normalized"].encode("utf-8")))
for c in o["invalid"]:
    eq(f"origin invalid {c['name']}", ("err", c["reason"]), origin_oracle(c["input"], c["local"] is True))
# TASKS T03 coverage: IDN, ß, trailing dot, IP literal, port 443, uppercase host, 268-byte origin.
vin = [c["input"] for c in o["valid"]]
ok("origins cover IDN", any(not i.isascii() for i in vin) and any("xn--" in c["normalized"] for c in o["valid"]))
ok("origins cover sharp s", any("\u00df" in i for i in vin))
ok("origins cover port 443", any(":443" in i for i in vin))
ok("origins cover uppercase host", any(any(ch.isupper() for ch in i.split("//", 1)[-1].split("/")[0]) for i in vin))
ok("origins cover 9 and 267 bytes", {9, 267} <= {c["bytes"] for c in o["valid"]})
ir = {c["reason"] for c in o["invalid"]}
ok("origins cover every refusal", {"invalid_url", "not_https", "userinfo", "trailing_dot", "ip_literal", "length"} <= ir)
ok("origins cover a 268-byte origin", any(c["reason"] == "length" and len(c["input"].encode()) == 268 for c in o["invalid"]))

# ---- headers (SPEC §2.5)
hd = docs["headers.json"]
for c in hd["bytes32"]["valid"]: ok(f"bytes32 valid {c['name']}", is_bytes32(c["value"]))
for c in hd["bytes32"]["invalid"]: ok(f"bytes32 invalid {c['name']}", not is_bytes32(c["value"]))
for c in hd["retryAfter"]["valid"]: ok(f"retryAfter valid {c['name']}", is_seconds(c["value"]))
for c in hd["retryAfter"]["invalid"]: ok(f"retryAfter invalid {c['name']}", not is_seconds(c["value"]))
for c in hd["payerSig"]["valid"]:
    n = f"payer {c['name']}"
    ok(f"{n} header grammar", parse_payer_sig(c["header"]) == (c["unixSeconds"], c["signature"]))
    ok(f"{n} requestId grammar", is_bytes32(c["requestId"]))
    msg = f"attested-exec:results:{c['requestId']}:{c['unixSeconds']}"
    eq(f"{n} msg", c["message"], msg)
    dg = cast("hash-message", msg)
    eq(f"{n} digest", c["digest"], dg)
    eq(f"{n} header", c["header"], f"{c['unixSeconds']}.{c['signature']}")
    eq(f"{n} signer is the recovered key", c["signer"], recover(dg, c["signature"]))
    ok(f"{n} signer non-empty", c["signer"] != "")
for c in hd["payerSig"]["invalid"]:
    ok(f"payer invalid {c['name']}", parse_payer_sig(c["header"]) is None)
for c in hd["attestedProof"]["valid"]:
    n = f"attestedProof {c['name']}"
    reason, obj, text = parse_attested_proof(c["header"])
    eq(f"{n} parses", reason, "ok")
    if reason != "ok": continue
    eq(f"{n} json is the header's bytes", c["json"], text)
    ok(f"{n} chainId/verifyingContract grammar", is_uint(c["chainId"], 256) and is_address(c["verifyingContract"]))
    eq(f"{n} signature", c["signature"], obj["signature"])
    eq(f"{n} signer", c["signer"], obj["signer"])
    pr = obj["proof"]
    eq(f"{n} ttl", int(pr["expiresAt"]) - int(pr["issuedAt"]), 600)
    _, dg = proof_digest(c["chainId"], c["verifyingContract"], pr)
    eq(f"{n} signer is the recovered key", obj["signer"], recover(dg, obj["signature"]))
for c in hd["attestedProof"]["invalid"]:
    eq(f"attestedProof invalid {c['name']}", c["reason"], parse_attested_proof(c["header"])[0])
    ok(f"attestedProof invalid {c['name']} reason is a refusal", c["reason"] != "ok")

print("checks:", count, "fails:", fails)
sys.exit(1 if fails else 0)
