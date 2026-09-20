"""Public uptime probe (Y3).

This account's Lambda memory quota is 512 MB. CloudWatch Synthetics
canaries require >= 960 MB, so the probe is a scheduled Lambda that
publishes the same CloudWatchSynthetics/SuccessPercent series Grafana
and devops-g10-probe-down already read.
"""

from __future__ import annotations

import os
import urllib.error
import urllib.request

import boto3

PATHS = ("/health", "/")
TIMEOUT_S = 10

cw = boto3.client("cloudwatch")


def handler(_event, _context):
    base = (os.environ.get("API_URL") or "").rstrip("/")
    name = os.environ.get("CANARY_NAME") or "devops-g10-probe"
    if not base:
        _put(name, 0.0)
        raise RuntimeError("API_URL is not set")

    ok = True
    for path in PATHS:
        url = base + path
        req = urllib.request.Request(url, headers={"User-Agent": "devops-g10-probe"})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
                code = res.status
                if code < 200 or code >= 400:
                    ok = False
        except (urllib.error.URLError, TimeoutError, OSError):
            ok = False

    _put(name, 100.0 if ok else 0.0)
    if not ok:
        raise RuntimeError("probe failed")
    return {"ok": True}


def _put(name, value):
    cw.put_metric_data(
        Namespace="CloudWatchSynthetics",
        MetricData=[
            {
                "MetricName": "SuccessPercent",
                "Dimensions": [{"Name": "CanaryName", "Value": name}],
                "Value": value,
                "Unit": "Percent",
            }
        ],
    )
