#!/usr/bin/env bash
# Two checks that catch the pipeline mistakes an agent reliably makes.
set -uo pipefail
D="${1:-.github/workflows}"; [ -d "$D" ] || { echo "no workflows at $D"; exit 0; }
fail=0

# 1. attacker-controlled context interpolated into a shell step
if grep -rnE '\$\{\{[[:space:]]*github\.event\.(issue|pull_request|comment|review|discussion)\.[a-z_.]*(title|body|name|login)' "$D" 2>/dev/null | grep -v 'env:'; then
  echo "FAIL: attacker-controlled context interpolated directly. Pass it through env: and quote the variable."
  fail=1
fi
if grep -rnE '\$\{\{[[:space:]]*github\.head_ref' "$D" 2>/dev/null | grep -v 'env:'; then
  echo "FAIL: github.head_ref is a fork-controlled branch name. Route it through env:."
  fail=1
fi

# 2. pull_request_target at all
if grep -rn 'pull_request_target' "$D" 2>/dev/null; then
  echo "FAIL: pull_request_target runs with secrets against a fork's pull request. Use pull_request, or justify it in a comment on the line and remove this check."
  fail=1
fi

# 3. every action pinned to a full commit sha, first-party included: tags move, and that is
#    how the known compromises worked. Scans the raw text, so flow mappings ({ uses: x@v })
#    and a value on the next line are caught too.
if ! python3 -I -c '
import pathlib, re, sys
bad = 0
for f in sorted(pathlib.Path(sys.argv[1]).glob("*.y*ml")):
    for m in re.finditer(r"\buses:\s*[\"\x27]?([^\s\"\x27#,}]+)", f.read_text()):
        ref = m.group(1)
        if ref.startswith(("./", "docker://")) or re.search(r"@[0-9a-f]{40}$", ref):
            continue
        print(f"FAIL unpinned action in {f.name}: {ref}")
        print("     Pin to a full 40-character commit sha, e.g. owner/repo@<sha> # v1.2.3")
        bad = 1
sys.exit(bad)
' "$D"; then fail=1; fi

[ "$fail" -eq 0 ] && echo "workflows clean"
exit $fail
