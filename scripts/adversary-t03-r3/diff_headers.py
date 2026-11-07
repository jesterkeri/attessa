# Differential: core header parsers vs the oracle's grammar functions on edge strings and on
# random single-edit mutants of the committed valid X-Attested-Proof JSON.
import base64, json, os, random, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oracle_lib
O = oracle_lib.load()
rnd = random.Random(7)
hd = json.load(open("vectors/headers.json", encoding="utf-8"))
b32 = "0x" + "ab" * 32; sig = hd["payerSig"]["valid"][0]["signature"]
cases = []
for v in [b32, b32 + "\n", "\n" + b32, b32.replace("a", "A", 1), "0x" + "٠" * 64, "0x" + "0" * 63 + "\u0661", b32 + "\x00", " " + b32]:
    cases.append(["b32", v])
for v in ["0", "00", "1", "10", "9" * 40, "١", "+1", "1 ", " 1", "1\n", "0x1", "1e3", "", "٣", "\uff11"]:
    cases.append(["retry", v])
for t in ["0", "00", "9007199254740991", "9007199254740992", "9007199254740993", "1" * 30, "١", "1\n", ""]:
    cases.append(["payer", f"{t}.{sig}"])
cases += [["payer", f"1.{sig}\n"], ["payer", f"1.{sig.upper()}"], ["payer", f"1..{sig}"], ["payer", f"1.{sig}.1"]]
base_json = [c["json"] for c in hd["attestedProof"]["valid"]]
ALPH = list('{}[]",:0123456789abcdefx \\u\n') + ["\ufeff", "\u00e9", "1e1", "-0", "null", "NaN", "\\u0030", "\\ud800"]
for i in range(1500):
    t = rnd.choice(base_json)
    op = rnd.randint(0, 3); j = rnd.randrange(len(t))
    if op == 0: t = t[:j] + rnd.choice(ALPH) + t[j:]
    elif op == 1: t = t[:j] + t[j + 1:]
    elif op == 2: t = t[:j] + rnd.choice(ALPH) + t[j + 1:]
    else:
        o = json.loads(t); ks = list(o["proof"]); k = rnd.choice(ks)
        o["proof"][k] = rnd.choice([o["proof"][k].upper(), "0" + o["proof"][k], int(o["proof"][k]) if o["proof"][k].isdigit() else 1, None, o["proof"][k] + "0"])
        t = json.dumps(o, separators=(",", ":"), sort_keys=True)
    try: h = base64.b64encode(t.encode("utf-8", "surrogatepass")).decode()
    except Exception: continue
    cases.append(["proof", h])
for c in hd["attestedProof"]["valid"]:
    h = c["header"]
    cases += [["proof", h + "\n"], ["proof", h.rstrip("=")], ["proof", h + "===="], ["proof", " " + h]]
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "header-cases.json")
json.dump(cases, open(p, "w"), ensure_ascii=False)
core = json.loads(subprocess.run(["node", os.path.join(os.path.dirname(os.path.abspath(__file__)), "core-headers.ts"), p], check=True, capture_output=True, text=True).stdout)
d = 0; acc = 0
for (k, v), c in zip(cases, core):
    if k == "b32": o = O["is_bytes32"](v)
    elif k == "retry": o = O["is_seconds"](v)
    elif k == "payer":
        r = O["parse_payer_sig"](v); o = f"{int(r[0])}.{r[1]}" if r else False
    else: o = O["parse_attested_proof"](v)[0] == "ok"
    acc += o is not False
    if o != c:
        d += 1; print("DIFF", k, repr(v)[:100], "core", c, "oracle", o)
print("cases", len(cases), "accepted", acc, "diffs", d)
