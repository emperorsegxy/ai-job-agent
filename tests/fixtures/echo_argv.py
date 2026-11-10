"""Test double for jobspy_wrapper.py. Prints argv and optionally one fake job. Never uses a shell."""
import json
import os
import sys

payload = {"script": sys.argv[0], "argv": sys.argv[1:], "executable": sys.executable}
out_path = os.environ.get("JOBSPY_ARGV_OUT")
if out_path:
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)

if os.environ.get("JOBSPY_EMIT_JOB") == "1":
    print(json.dumps([
        {
            "id": "job-1",
            "title": "Backend Engineer",
            "company": "Example",
            "location": "Berlin",
            "workplace_type": "Remote",
            "job_url": "https://example.com/jobs/1",
            "description": "Build APIs",
            "site": "indeed",
            "date_posted": "2026-11-01",
        }
    ]))
else:
    print("[]")
