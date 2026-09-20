"""06:31 EAT: 1 if payouts still pending/disbursing, else 0."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import boto3

cw = boto3.client("cloudwatch")
NAMESPACE = "TillFlow"
METRIC = "payouts_unsettled_after_cutoff"


def handler(_event, _context):
    pending = _gauge("pending")
    disbursing = _gauge("disbursing")
    unsettled = pending + disbursing
    value = 1.0 if unsettled > 0 else 0.0
    cw.put_metric_data(
        Namespace=NAMESPACE,
        MetricData=[
            {
                "MetricName": METRIC,
                "Value": value,
                "Unit": "None",
            }
        ],
    )
    return {"pending": pending, "disbursing": disbursing, "value": value}


def _gauge(status):
    expr = (
        "SUM(SEARCH('{TillFlow} MetricName=\"payouts_by_status\" "
        f"status=\"{status}\"', 'Maximum', 300))"
    )
    end = datetime.now(timezone.utc)
    start = end - timedelta(minutes=15)
    resp = cw.get_metric_data(
        MetricDataQueries=[
            {"Id": "m", "Expression": expr, "ReturnData": True},
        ],
        StartTime=start,
        EndTime=end,
    )
    results = resp.get("MetricDataResults") or []
    values = results[0].get("Values") if results else []
    return max(values) if values else 0.0
