# Async work + DLQ. One primary queue + one DLQ per async workflow.
# Payments callback processing queue lands here as the starter; more will be
# added at G2 as services need them.

resource "aws_sqs_queue" "payments_callbacks_dlq" {
  name                       = "${var.name_prefix}-payments-callbacks-dlq"
  message_retention_seconds  = 1209600 # 14 days
  visibility_timeout_seconds = 60
  sqs_managed_sse_enabled    = true

  tags = {
    service = "payments"
    role    = "dlq"
  }
}

resource "aws_sqs_queue" "payments_callbacks" {
  name                       = "${var.name_prefix}-payments-callbacks"
  message_retention_seconds  = 345600 # 4 days
  visibility_timeout_seconds = 60
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.payments_callbacks_dlq.arn
    maxReceiveCount     = 5
  })

  tags = {
    service = "payments"
    role    = "primary"
  }
}

resource "aws_sqs_queue" "commission_close_dlq" {
  name                       = "${var.name_prefix}-commission-close-dlq"
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = 300
  sqs_managed_sse_enabled    = true

  tags = {
    service = "commission"
    role    = "dlq"
  }
}

resource "aws_sqs_queue" "commission_close" {
  name                       = "${var.name_prefix}-commission-close"
  message_retention_seconds  = 345600
  visibility_timeout_seconds = 300
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.commission_close_dlq.arn
    maxReceiveCount     = 3
  })

  tags = {
    service = "commission"
    role    = "primary"
  }
}
