# Amazon Managed Grafana (ADR-005). SSO login. CloudWatch + X-Ray datasources.
# Dashboards: Saloi writes infra/grafana/*.json; this module loads every file.

data "aws_iam_policy_document" "grafana_trust" {
  statement {
    sid     = "GrafanaAssume"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["grafana.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:grafana:${local.region}:${local.account_id}:/workspaces/*"]
    }
  }
}

data "aws_iam_policy_document" "grafana" {
  statement {
    sid    = "CloudWatchRead"
    effect = "Allow"
    actions = [
      "cloudwatch:DescribeAlarmsForMetric",
      "cloudwatch:DescribeAlarmHistory",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:ListMetrics",
      "cloudwatch:GetMetricStatistics",
      "cloudwatch:GetMetricData",
      "cloudwatch:GetInsightRuleReport",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "LogsInsights"
    effect = "Allow"
    actions = [
      "logs:DescribeLogGroups",
      "logs:GetLogGroupFields",
      "logs:StartQuery",
      "logs:StopQuery",
      "logs:GetQueryResults",
      "logs:GetLogEvents",
      "logs:FilterLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "XRayRead"
    effect = "Allow"
    actions = [
      "xray:BatchGetTraces",
      "xray:GetTraceSummaries",
      "xray:GetTraceGraph",
      "xray:GetGroups",
      "xray:GetTimeSeriesServiceStatistics",
      "xray:GetInsightSummaries",
      "xray:GetInsight",
      "xray:GetServiceGraph",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "CloudWatchDimensionLookups"
    effect = "Allow"
    actions = [
      "ec2:DescribeTags",
      "ec2:DescribeInstances",
      "ec2:DescribeRegions",
      "tag:GetResources",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role" "grafana" {
  name               = "${var.name_prefix}-grafana"
  description        = "Amazon Managed Grafana workspace role (CloudWatch + X-Ray)."
  assume_role_policy = data.aws_iam_policy_document.grafana_trust.json
  tags               = { service = "grafana" }
}

resource "aws_iam_policy" "grafana" {
  name        = "${var.name_prefix}-grafana"
  description = "Read CloudWatch, Logs Insights, and X-Ray for Grafana panels."
  policy      = data.aws_iam_policy_document.grafana.json
}

resource "aws_iam_role_policy_attachment" "grafana" {
  role       = aws_iam_role.grafana.name
  policy_arn = aws_iam_policy.grafana.arn
}

# G5 scar: workspace g-ede3f6a694 is DELETION_FAILED. Cohort SSO
# explicitly denies sso:DeleteManagedApplicationInstance. Refreshing
# this resource 404s DescribeWorkspaceConfiguration and blocks Release.
# Human login is Grafana Cloud (ADR-005). JSON files stay the contract.
removed {
  from = aws_grafana_workspace.amg

  lifecycle {
    destroy = false
  }
}
