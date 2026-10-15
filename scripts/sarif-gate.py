"""Fail when a SARIF file has a result whose rule security-severity is >= 7.0 (high/critical)."""

import json
import sys

THRESHOLD = 7.0


def severity(rule: dict) -> float:
    return float(rule.get("properties", {}).get("security-severity", 0))


blocking = []
for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as f:
        sarif = json.load(f)
    for run in sarif.get("runs", []):
        rules = {r["id"]: r for r in run["tool"]["driver"].get("rules", [])}
        for result in run.get("results", []):
            rule = rules.get(result.get("ruleId"), {})
            if severity(rule) >= THRESHOLD:
                loc = result["locations"][0]["physicalLocation"]
                blocking.append(
                    f"{loc['artifactLocation']['uri']}:{loc.get('region', {}).get('startLine', '?')} "
                    f"{result['ruleId']} ({severity(rule)}): {result['message']['text']}"
                )

for line in blocking:
    print(line)
print(f"{len(blocking)} high/critical finding(s)")
sys.exit(1 if blocking else 0)
