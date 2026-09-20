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

resource "aws_grafana_workspace" "amg" {
  name                     = "${var.name_prefix}-grafana"
  description              = "TillFlow SLO / burn / RED / traces. ADR-005."
  account_access_type      = "CURRENT_ACCOUNT"
  authentication_providers = ["AWS_SSO"]
  permission_type          = "CUSTOMER_MANAGED"
  role_arn                 = aws_iam_role.grafana.arn
  data_sources             = ["CLOUDWATCH", "XRAY"]
  grafana_version          = "10.4"

  tags = { service = "grafana" }

  depends_on = [
    aws_iam_role_policy_attachment.grafana,
    aws_iam_policy.ci_deploy,
  ]
}

# Terraform publishes dashboards through the Grafana HTTP API. SSO user
# assignment is out of band (console). If this account cannot assign SSO
# users, switch to Grafana Cloud the same day (ADR-005) — the JSON files
# stay the contract.
resource "aws_grafana_workspace_service_account" "terraform" {
  name         = "terraform"
  grafana_role = "ADMIN"
  workspace_id = aws_grafana_workspace.amg.id
}

resource "aws_grafana_workspace_service_account_token" "terraform" {
  name               = "terraform"
  service_account_id = aws_grafana_workspace_service_account.terraform.service_account_id
  workspace_id       = aws_grafana_workspace.amg.id
  seconds_to_live    = 2592000 # AMG max; capstone apply cadence refreshes it
}

resource "grafana_folder" "tillflow" {
  uid   = "tillflow"
  title = "TillFlow"
}

resource "grafana_dashboard" "json" {
  for_each    = fileset("${path.module}/grafana", "*.json")
  folder      = grafana_folder.tillflow.uid
  overwrite   = true
  config_json = file("${path.module}/grafana/${each.value}")
}
