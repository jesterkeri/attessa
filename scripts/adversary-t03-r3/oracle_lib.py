# Loads the oracle's functions (everything before it reads vectors/) without running its vector checks.
import os
SRC = os.path.join(os.path.dirname(__file__), "..", "check-vectors-oracle.py")
def load():
    src = open(SRC, encoding="utf-8").read()
    cut = src.index("docs = {f: V(f)")
    ns = {"__name__": "oracle", "__file__": SRC}
    exec(compile(src[:cut], SRC, "exec"), ns)
    return ns
