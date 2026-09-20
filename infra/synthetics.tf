# External uptime probe (Y3). Hits public API Gateway /health and /.
# SuccessPercent (CloudWatchSynthetics / CanaryName=devops-g10-probe) is
# the Grafana uptime signal and devops-g10-probe-down.
#
# Not a CloudWatch Synthetics canary: that runtime needs >= 960 MB and
# this account's Lambda quota caps MemorySize at 512 MB (CREATE_FAILED
# on the first Release). A 128 MB Lambda on a 1-minute EventBridge rule
# publishes the same metric contract.

data "aws_iam_policy_document" "probe_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "probe" {
  statement {
    sid    = "ProbeLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.probe.arn}:*"]
  }

  statement {
    sid       = "ProbeMetrics"
    effect    = "Allow"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["CloudWatchSynthetics"]
    }
  }
}

resource "aws_iam_role" "probe" {
  name               = "${var.name_prefix}-probe"
  description        = "Scheduled public /health + / probe. Emits CloudWatchSynthetics SuccessPercent."
  assume_role_policy = data.aws_iam_policy_document.probe_trust.json
  tags               = { service = "reliability" }
}

resource "aws_iam_policy" "probe" {
  name   = "${var.name_prefix}-probe"
  policy = data.aws_iam_policy_document.probe.json
}

resource "aws_iam_role_policy_attachment" "probe" {
  role       = aws_iam_role.probe.name
  policy_arn = aws_iam_policy.probe.arn
}

resource "aws_cloudwatch_log_group" "probe" {
  name              = "/aws/lambda/${var.name_prefix}-probe"
  retention_in_days = 30
  tags              = { service = "reliability" }
}

data "archive_file" "probe" {
  type        = "zip"
  source_file = "${path.module}/lambda/probe/index.py"
  output_path = "${path.module}/.build/probe.zip"
}

resource "aws_lambda_function" "probe" {
  function_name    = "${var.name_prefix}-probe"
  role             = aws_iam_role.probe.arn
  filename         = data.archive_file.probe.output_path
  source_code_hash = data.archive_file.probe.output_base64sha256
  handler          = "index.handler"
  runtime          = "python3.12"
  timeout          = 30
  memory_size      = 128

  environment {
    variables = {
      API_URL     = aws_apigatewayv2_api.app.api_endpoint
      CANARY_NAME = "${var.name_prefix}-probe"
    }
  }

  tracing_config {
    mode = "PassThrough"
  }

  tags = { service = "reliability" }

  depends_on = [
    aws_iam_role_policy_attachment.probe,
    aws_cloudwatch_log_group.probe,
    aws_iam_policy.ci_deploy,
  ]
}

resource "aws_cloudwatch_event_rule" "probe" {
  name                = "${var.name_prefix}-probe"
  description         = "Public uptime probe every 1 minute (Y3)."
  schedule_expression = "rate(1 minute)"
  tags                = { service = "reliability" }
}

resource "aws_cloudwatch_event_target" "probe" {
  rule = aws_cloudwatch_event_rule.probe.name
  arn  = aws_lambda_function.probe.arn
}

resource "aws_lambda_permission" "probe" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.probe.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.probe.arn
}
