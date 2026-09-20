#!/usr/bin/env python3
"""Set devops-g10-waf RateLimitExceptCallback limit. Usage: set-waf-limit.py 200"""
import json
import os
import subprocess
import sys

LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 200
PROFILE = os.environ.get("AWS_PROFILE", "g10")
REGION = os.environ.get("AWS_REGION", "eu-central-1")
ACL_ID = "c3161d06-8c94-41f8-a55a-404a94326b01"
NAME = "devops-g10-waf"


def aws_json(*args):
    cmd = ["aws", *args, "--profile", PROFILE, "--region", REGION, "--output", "json"]
    return json.loads(subprocess.check_output(cmd))


acl = aws_json("wafv2", "get-web-acl", "--name", NAME, "--scope", "REGIONAL", "--id", ACL_ID)
web = acl["WebACL"]
for rule in web["Rules"]:
    if rule["Name"] == "RateLimitExceptCallback":
        print(f"current={rule['Statement']['RateBasedStatement']['Limit']}", flush=True)
        rule["Statement"]["RateBasedStatement"]["Limit"] = LIMIT
        break
else:
    sys.exit("RateLimitExceptCallback not found")

cmd = [
    "aws", "wafv2", "update-web-acl",
    "--name", NAME,
    "--scope", "REGIONAL",
    "--id", web["Id"],
    "--default-action", json.dumps(web["DefaultAction"]),
    "--rules", json.dumps(web["Rules"]),
    "--visibility-config", json.dumps(web["VisibilityConfig"]),
    "--lock-token", acl["LockToken"],
    "--profile", PROFILE,
    "--region", REGION,
]
if web.get("Description"):
    cmd.extend(["--description", web["Description"]])
subprocess.check_call(cmd)
print(f"waf_set={LIMIT}", flush=True)
