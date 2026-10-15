"""Fail when a Scout JSON report has any critical, medium or minor finding (plan §6).

Enhancements are reported but do not block; each must be explained in
docs/security/contract-review.md.
"""

import json
import sys

BLOCKING = ("critical", "medium", "minor")

with open(sys.argv[1], encoding="utf-8") as f:
    report = json.load(f)

counts = report["summary"]["by_severity"]
for finding in report["findings"]:
    print(f"{finding['vulnerability_id']} {finding['file_path']}:{finding['span']} {finding['error_message']}")
print(", ".join(f"{k}={counts.get(k, 0)}" for k in (*BLOCKING, "enhancement")))
sys.exit(1 if any(counts.get(k, 0) for k in BLOCKING) else 0)
