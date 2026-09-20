# External uptime probe (Y3). Runs outside the VPC against the public
# API Gateway. SuccessPercent is the Grafana uptime signal.

data "aws_iam_policy_document" "probe_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type = "Service"
      identifiers = [
        "lambda.amazonaws.com",
        "synthetics.amazonaws.com",
      ]
    }
  }
}

data "aws_iam_policy_document" "probe" {
  statement {
    sid    = "WriteArtifacts"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetBucketLocation",
    ]
    resources = [
      aws_s3_bucket.artifacts.arn,
      "${aws_s3_bucket.artifacts.arn}/synthetics/probe/*",
    ]
  }

  statement {
    sid       = "ListArtifacts"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.artifacts.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["synthetics/probe/*"]
    }
  }

  statement {
    sid    = "CanaryLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:${local.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/cwsyn-${var.name_prefix}-probe*",
    ]
  }

  statement {
    sid       = "CanaryMetrics"
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
  description        = "CloudWatch Synthetics execution role for devops-g10-probe."
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

data "archive_file" "probe" {
  type        = "zip"
  output_path = "${path.module}/.build/probe.zip"

  source {
    content  = file("${path.module}/canaries/probe/index.js")
    filename = "index.js"
  }
}

resource "aws_synthetics_canary" "probe" {
  name                 = "${var.name_prefix}-probe"
  artifact_s3_location = "s3://${aws_s3_bucket.artifacts.bucket}/synthetics/probe"
  execution_role_arn   = aws_iam_role.probe.arn
  handler              = "index.handler"
  runtime_version      = "syn-nodejs-puppeteer-17.0"
  zip_file             = data.archive_file.probe.output_path
  start_canary         = true
  delete_lambda        = true

  success_retention_period = 2
  failure_retention_period = 14

  schedule {
    expression = "rate(1 minute)"
  }

  run_config {
    timeout_in_seconds = 30
    environment_variables = {
      API_URL = aws_apigatewayv2_api.app.api_endpoint
    }
  }

  tags = { service = "reliability" }

  depends_on = [
    aws_iam_role_policy_attachment.probe,
    aws_iam_policy.ci_deploy,
  ]
}
