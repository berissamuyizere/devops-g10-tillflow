# Daily EventBridge rule that kicks off the commission close job.
# The rule enqueues a message on the commission close queue; the Commission
# worker (G2) is what actually processes it. No public ingress.

resource "aws_cloudwatch_event_rule" "commission_daily" {
  name                = "${var.name_prefix}-commission-daily-close"
  description         = "Fires once a day after business close in Africa/Nairobi (EAT)."
  schedule_expression = "cron(45 20 * * ? *)" # 20:45 UTC = 23:45 EAT

  tags = {
    service = "commission"
  }
}

resource "aws_cloudwatch_event_target" "commission_daily_sqs" {
  rule      = aws_cloudwatch_event_rule.commission_daily.name
  target_id = "commission-close-queue"
  arn       = aws_sqs_queue.commission_close.arn

  input_transformer {
    input_paths    = { time = "$.time" }
    input_template = <<EOF
{
  "type": "commission.daily-close",
  "scheduled_at": <time>,
  "reason": "eventbridge.cron"
}
EOF
  }
}

# Allow EventBridge to write to the SQS queue.
data "aws_iam_policy_document" "commission_close_from_events" {
  statement {
    sid    = "AllowEventBridge"
    effect = "Allow"
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.commission_close.arn]
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.commission_daily.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "commission_close" {
  queue_url = aws_sqs_queue.commission_close.id
  policy    = data.aws_iam_policy_document.commission_close_from_events.json
}
