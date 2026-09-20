"""SNS → Slack. Reads the webhook from Secrets Manager on every invoke."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

import boto3

SECRET_ID = os.environ["SLACK_SECRET_ID"]
ENVIRONMENT = os.environ.get("ENVIRONMENT", "prod")
GRAFANA_URL = os.environ.get("GRAFANA_URL", "")
RUNBOOK_BASE = os.environ.get(
    "RUNBOOK_BASE",
    "https://github.com/berissamuyizere/devops-g10-tillflow/blob/main/docs/runbook.md",
)

_sm = boto3.client("secretsmanager")

CONTRACT_KEYS = (
    ("environment", ("environment",)),
    ("service", ("service",)),
    ("symptom", ("symptom",)),
    ("slo_impact", ("slo_impact", "SLO impact", "slo impact")),
    ("observed", ("observed", "observed_value", "observed value")),
    ("grafana_panel", ("grafana_panel", "Grafana panel", "grafana")),
    ("runbook", ("runbook", "runbook_link", "runbook link")),
    ("owner", ("owner",)),
    ("first_safe_action", ("first_safe_action", "first safe action")),
)


def handler(event, _context):
    webhook = _webhook_url()
    if not webhook or webhook == "PLACEHOLDER":
        print("slack webhook not populated in Secrets Manager")
        return {"ok": False, "reason": "placeholder"}

    posted = 0
    for record in event.get("Records", []):
        sns = record.get("Sns") or {}
        raw = sns.get("Message") or ""
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            message = {"AlarmDescription": raw, "NewStateValue": "ALARM"}
        if not isinstance(message, dict):
            continue
        payload = _format_alarm(message)
        _post(webhook, payload)
        posted += 1
    return {"ok": True, "posted": posted}


def _webhook_url():
    raw = _sm.get_secret_value(SecretId=SECRET_ID)["SecretString"]
    data = json.loads(raw)
    return data.get("url") or data.get("webhook") or ""


def _pick(desc, names, default=""):
    for name in names:
        value = desc.get(name)
        if value is not None and str(value).strip() != "":
            return str(value)
    return default


def _parse_description(raw):
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, TypeError):
        pass
    return {"symptom": str(raw)}


def _format_alarm(msg):
    desc = _parse_description(msg.get("AlarmDescription"))
    fields = {key: _pick(desc, names) for key, names in CONTRACT_KEYS}

    state = str(msg.get("NewStateValue") or "")
    firing = state == "ALARM"
    env = fields["environment"] or ENVIRONMENT
    service = fields["service"] or "unknown"
    symptom = fields["symptom"] or msg.get("AlarmName") or "alarm"
    observed = fields["observed"] or msg.get("NewStateReason") or state
    grafana = fields["grafana_panel"] or GRAFANA_URL
    runbook = fields["runbook"] or RUNBOOK_BASE
    owner = fields["owner"] or "see CODEOWNERS"
    first_action = fields["first_safe_action"] or "see runbook"
    slo_impact = fields["slo_impact"] or "n/a"

    tone = "FIRING" if firing else "RECOVERED"
    color = "#d93025" if firing else "#2eb886"
    title = f"[{env}] {service} — {tone}: {symptom}"

    attachment_fields = [
        {"title": "SLO impact", "value": slo_impact, "short": False},
        {"title": "Observed", "value": observed, "short": False},
        {"title": "Grafana panel", "value": grafana, "short": False},
        {"title": "Runbook", "value": runbook, "short": False},
        {"title": "Owner", "value": owner, "short": True},
        {"title": "First safe action", "value": first_action, "short": True},
    ]
    return {
        "attachments": [
            {
                "color": color,
                "title": title,
                "fields": attachment_fields,
                "footer": "devops-g10-tillflow",
                "ts": int(time.time()),
            }
        ]
    }


def _post(url, payload):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"slack post failed: {err.code}") from err
