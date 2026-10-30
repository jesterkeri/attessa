# Differential: core normalizeOrigin vs the oracle's origin_oracle on hand-picked edge inputs.
import json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oracle_lib
O = oracle_lib.load()
H = ["ẞ", "ᾀ", "ᾈ", "ꭰ", "Ꭰ", "ᏸ", "ς", "Σ", "σ", "İ", "ǅ", "ﬀ", "ſ", "K", "Ω", "Å", "ϐ", "µ", "⁤", "᠏", "\U0001bca0",
     "​", "­", "a‌b", "क्‍", "�", "%ff", "%c3%bc", "%C3%9F", "⿰", "ㅤ", "ᅟ", "ﾠ", "឴",
     "⠀", "♥", "_", "a_b", "*", "$", "xn--zca", "XN--ZCA", "xn--ss-", "xn--", "xn---", "xn--ls8h", "a..b", ".a", "a-", "-a", "ab--c",
     "a。b", "a．b", "a｡b", "ש", "שa", "aא", "א1", "ا١", "ا۱١", "1א", "א̀",
     "̀a", "à", "ำ", "ཷ", "Ⅳ", "⒈", "①", "½", "℀", "︒", "\U000e0001", "\U00010000", "\U0001f1e6",
     "ൎ", "ẞ", "Ⱟ", "Ꟁ", "\U0001e030", "೏", "\U00011f00", "\U00031350", "ࣇ", "᜕", "\U0001f6dc"]
cases = []
for h in H:
    cases.append([f"https://{h}.com", False])
    cases.append([f"https://a.{h}", False])
for u in ["https://@example.com", "https://:@example.com", "https://example.com:", "https://example.com:/", "https://exa mple.com",
          "https:example.com", "https:\\\\example.com", "https:/example.com", " https://example.com ", "https://exa\tmple.com",
          "https://1.2.3", "https://0x7f000001", "https://1.2.3.4.", "https://999.1.1.1", "https://a.1", "https://a.0x", "https://a.0xg",
          "https://1.0x", "https://09.1.1.1", "https://example.com:65535", "https://example.com:65536", "https://example.com:00000443",
          "https://example.com?x", "https://example.com#x", "https://example.com\\x", "https://[::1]", "https://[::ffff:1.2.3.4]:8443",
          "https://[fe80::1%25eth0]", "https://[1:0:0:2:0:0:0:3]:1", "https://[0:0:1:0:0:1:0:0]:1", "https://[::1.02.3.4]", "HTTP://LOCALHOST:1",
          "http://localhost:80", "http://localhost:0080", "http://LOCALHOST.:1", "http://127.0.0.1:1", "https://localhost", "wss://example.com",
          "https://exa%2fmple.com", "https://ex%00ample.com", "https://%2e", "https://a%2e", "https://％ｅxample.com", "https://example.com%20"]:
    cases.append([u, False]); cases.append([u, True])
tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "origin-cases.json")
json.dump(cases, open(tmp, "w"), ensure_ascii=False)
core = json.loads(subprocess.run(["node", os.path.join(os.path.dirname(os.path.abspath(__file__)), "core-origins.ts"), tmp], check=True, capture_output=True, text=True).stdout)
d = 0
for (inp, local), c in zip(cases, core):
    o = list(O["origin_oracle"](inp, local))
    if o != c:
        d += 1; print(f"DIFF {inp!r} local={local}: core={c} oracle={o}")
print("cases", len(cases), "diffs", d)
