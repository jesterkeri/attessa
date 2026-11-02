# Differential: core normalizeOrigin vs the oracle's origin_oracle on joiner (ZWNJ/ZWJ) hosts and
# opaque hosts whose punycode decodes to a joiner. Prints every disagreement; exit 1 if any.
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "adversary-t03-r3"))
import oracle_lib
O = oracle_lib.load()
ZWNJ, ZWJ, VIR = "‌", "‍", "्"
B, KA, SSA, T = "ب", "क", "ष", "ً"  # beh (D), ka, ssa, fathatan (T)
labels = [f"{B}{ZWNJ}{B}", f"a{ZWNJ}b", f"{B}{ZWNJ}", f"{ZWNJ}{B}", f"{KA}{VIR}{ZWJ}{SSA}", f"a{ZWJ}b", f"{ZWJ}a",
          f"{B}{T}{ZWNJ}{T}{B}", f"{B}{ZWNJ}{B}{ZWNJ}a", f"{KA}{VIR}{ZWNJ}{B}{ZWNJ}{B}", f"{KA}{VIR}{ZWNJ}a{ZWNJ}{B}",
          f"{B}{ZWNJ}{ZWNJ}{B}", f"{B}{ZWJ}{ZWNJ}{B}", f"ﺑ{ZWNJ}ﺑ", f"{B}­{ZWNJ}{B}", f"{KA}{VIR}{ZWJ}{ZWJ}{SSA}"]
cases = []
for l in labels:
    for tmpl in ("https://{}.com", "https://a.{}.com", "https://a.b.{}", "https://{}｡{}.com", "https://{}。com",
                 "http://{}.com", "file://{}/x", "foo://{}/x", "ws://{}"):
        cases.append([tmpl.format(l, l), False])
    puny = "xn--" + l.encode("punycode").decode("ascii")
    for tmpl in ("https://{}.com", "https://a.{}", "foo://{}", "foo://a.{}/x", "git://u@{}:22/x", "file://{}/x", "http://{}"):
        cases.append([tmpl.format(puny), False])
tmp = os.path.join(HERE, "joiner-cases.json")
json.dump(cases, open(tmp, "w"), ensure_ascii=False)
core = json.loads(subprocess.run(["node", os.path.join(HERE, "..", "adversary-t03-r3", "core-origins.ts"), tmp],
                                 check=True, capture_output=True, text=True).stdout)
os.remove(tmp)
d = 0
for (inp, local), c in zip(cases, core):
    o = list(O["origin_oracle"](inp, local))
    if o != c:
        d += 1; print(f"DIFF {inp!r} core={c} oracle={o}")
print(f"{len(cases)} cases, {d} disagreements")
sys.exit(1 if d else 0)
