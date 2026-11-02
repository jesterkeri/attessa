"""Summarise a Slither --json result against the triage db (argv[2])."""
import json, sys

res = json.load(open(sys.argv[1]))
db = {r["id"] for r in json.load(open(sys.argv[2]))}
dets = (res.get("results") or {}).get("detectors", [])
print(f"results={len(dets)} success={res.get('success')} error={res.get('error')}")
for r in dets:
    files = sorted({e["source_mapping"]["filename_relative"] for e in r["elements"] if "source_mapping" in e})
    tag = "IN_DB" if r["id"] in db else "NEW"
    print(f"  {tag} {r['id'][:12]} {r['check']} ({r['impact']}) files={files}")
