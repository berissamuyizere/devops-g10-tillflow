# Slack path (Y4). CloudWatch alarm → SNS devops-g10-alerts → Lambda.
# The webhook is read from Secrets Manager on every invoke. Never in Git,
# TF vars, or Lambda environment. Y5 attaches alarm + OK actions here.
#
# Put the Slack contract in each alarm's description as JSON:
# {
#   "environment", "service", "symptom", "slo_impact", "observed",
#   "grafana_panel", "runbook", "owner", "first_safe_action"
# }

data "aws_iam_policy_document" "slack_notifier_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "slack_notifier" {
  statement {
    sid       = "ReadSlackWebhook"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.slack.arn]
  }

  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.slack_notifier.arn}:*"]
  }

  statement {
    sid    = "XRay"
    effect = "Allow"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role" "slack_notifier" {
  name               = "${var.name_prefix}-slack-notifier"
  description        = "Lambda role: read Slack webhook secret, write own logs."
  assume_role_policy = data.aws_iam_policy_document.slack_notifier_trust.json
  tags               = { service = "reliability" }
}

resource "aws_iam_policy" "slack_notifier" {
  name   = "${var.name_prefix}-slack-notifier"
  policy = data.aws_iam_policy_document.slack_notifier.json
}

resource "aws_iam_role_policy_attachment" "slack_notifier" {
  role       = aws_iam_role.slack_notifier.name
  policy_arn = aws_iam_policy.slack_notifier.arn
}

resource "aws_cloudwatch_log_group" "slack_notifier" {
  name              = "/aws/lambda/${var.name_prefix}-slack-notifier"
  retention_in_days = 30
  tags              = { service = "reliability" }
}

data "archive_file" "slack_notifier" {
  type        = "zip"
  source_file = "${path.module}/lambda/slack_notifier/index.py"
  output_path = "${path.module}/.build/slack_notifier.zip"
}

resource "aws_lambda_function" "slack_notifier" {
  function_name    = "${var.name_prefix}-slack-notifier"
  role             = aws_iam_role.slack_notifier.arn
  filename         = data.archive_file.slack_notifier.output_path
  source_code_hash = data.archive_file.slack_notifier.output_base64sha256
  handler          = "index.handler"
  runtime          = "python3.12"
  timeout          = 15
  memory_size      = 128
  architectures    = ["x86_64"]

  environment {
    variables = {
      SLACK_SECRET_ID = aws_secretsmanager_secret.slack.name
      ENVIRONMENT     = var.environment
      GRAFANA_URL     = "https://punywaxwing1700.grafana.net"
      RUNBOOK_BASE    = "https://github.com/${var.github_org}/${var.github_repo}/blob/main/docs/runbook.md"
    }
  }

  tracing_config {
    mode = "Active"
  }

  tags = { service = "reliability" }

  depends_on = [
    aws_iam_role_policy_attachment.slack_notifier,
    aws_cloudwatch_log_group.slack_notifier,
    aws_iam_policy.ci_deploy,
  ]
}

# Customer-managed key — CloudWatch/EventBridge cannot publish to a topic
# encrypted with alias/aws/sns. This key's policy lets those services
# GenerateDataKey so alarms still reach Slack.
data "aws_iam_policy_document" "alerts_kms" {
  statement {
    sid    = "EnableAccountAdmin"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "AllowSNSAndPublishers"
    effect = "Allow"
    principals {
      type = "Service"
      identifiers = [
        "sns.amazonaws.com",
        "cloudwatch.amazonaws.com",
        "events.amazonaws.com",
      ]
    }
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_kms_key" "alerts" {
  description             = "Encrypt SNS topic ${var.name_prefix}-alerts."
  deletion_window_in_days = 7
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.alerts_kms.json
  tags                    = { service = "reliability" }

  # Same apply that first mints this key also expands ci-deploy. Wait for
  # that policy so TagResource is allowed before CreateKey+tags.
  depends_on = [aws_iam_policy.ci_deploy]
}

resource "aws_kms_alias" "alerts" {
  name          = "alias/${var.name_prefix}-alerts"
  target_key_id = aws_kms_key.alerts.key_id
}

resource "aws_sns_topic" "alerts" {
  name              = "${var.name_prefix}-alerts"
  kms_master_key_id = aws_kms_key.alerts.arn
  tags              = { service = "reliability" }
}

data "aws_iam_policy_document" "alerts_sns" {
  statement {
    sid    = "AllowCloudWatchAndEvents"
    effect = "Allow"
    principals {
      type = "Service"
      identifiers = [
        "cloudwatch.amazonaws.com",
        "events.amazonaws.com",
      ]
    }
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_sns.json
}

resource "aws_lambda_permission" "alerts_sns" {
  statement_id  = "AllowSNS"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.slack_notifier.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.alerts.arn
}

resource "aws_sns_topic_subscription" "slack" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.slack_notifier.arn

  depends_on = [aws_lambda_permission.alerts_sns]
}
