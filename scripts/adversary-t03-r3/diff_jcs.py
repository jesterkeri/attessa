# Differential: core jcs vs the oracle's jcs on random JSON (random doubles by bit pattern,
# astral and control characters, lone-surrogate escapes, duplicate keys, deep nesting).
import json, os, random, struct, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oracle_lib
O = oracle_lib.load()
rnd = random.Random(int(sys.argv[1]) if len(sys.argv) > 1 else 1)
POOL = [0x0, 0x1f, 0x7f, 0x2028, 0x2029, 0xe9, 0x20ac, 0xfb33, 0xffff, 0xfeff, 0x1f600, 0x10ffff, 0xe000, 0x22, 0x5c, 0x2f, 0x08, 0x0c]
def rstr():
    out = []
    for _ in range(rnd.randint(0, 5)):
        c = rnd.choice(POOL + [rnd.randint(0x20, 0x7e), rnd.randint(0x80, 0xffff), rnd.randint(0x10000, 0x10ffff)])
        if 0xd800 <= c <= 0xdfff: c = 0x41
        out.append(json.dumps(chr(c))[1:-1])
    return "".join(out)
def rnum():
    k = rnd.randint(0, 4)
    if k == 0: return repr(struct.unpack(">d", os.urandom(8) if False else rnd.getrandbits(64).to_bytes(8, "big"))[0])
    if k == 1: return rnd.choice(["-0", "-0.0", "1e21", "1e-7", "5e-7", "1E400", "0.1", "100", "1e20", "123456789012345678901234567890", "-1e-7", "4.35", "0.000001", "1.0"])
    if k == 2: return str(rnd.randint(-2**60, 2**60))
    return repr(rnd.uniform(-1e6, 1e6))
def rval(d):
    k = rnd.randint(0, 6 if d < 4 else 3)
    if k == 0: return rnd.choice(["null", "true", "false"])
    if k == 1: return rnum()
    if k in (2, 3): return '"' + rstr() + '"'
    if k == 4: return "[" + ",".join(rval(d + 1) for _ in range(rnd.randint(0, 3))) + "]"
    keys = [rstr() for _ in range(rnd.randint(0, 4))]
    if keys and rnd.random() < 0.2: keys.append(keys[0])  # duplicate key, last wins
    return "{" + ",".join('"' + k + '":' + rval(d + 1) for k in keys) + "}"
texts = []
for _ in range(int(sys.argv[2]) if len(sys.argv) > 2 else 3000):
    t = rval(0)
    if "nan" in t or "inf" in t: continue
    texts.append(t)
texts += ['"\\ud800"', '{"\\udc00":1}', '"\\ud83d\\ude00"', '{"a":1,"a":2}', "[-0]", "1e400"]
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jcs-cases.txt")
open(p, "w").write("\n".join(texts) + "\n")
core = json.loads(subprocess.run(["node", os.path.join(os.path.dirname(os.path.abspath(__file__)), "core-jcs.ts"), p], check=True, capture_output=True, text=True).stdout)
d = 0
for t, c in zip(texts, core):
    try: o = O["jcs"](json.loads(t))
    except (ValueError, TypeError, OverflowError): o = "ERR"
    if o != c:
        d += 1
        if d <= 10: print("DIFF", t[:120], "| core", c[:120], "| oracle", o[:120])
print("cases", len(texts), "diffs", d)
