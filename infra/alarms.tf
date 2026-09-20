# CloudWatch alarms (Y5). Names and math are the contract in docs/alerts.md.
# Every alarm pages or tickets through SNS devops-g10-alerts on ALARM and OK.

locals {
  grafana_base  = "https://${aws_grafana_workspace.amg.endpoint}"
  runbook_base  = "https://github.com/${var.github_org}/${var.github_repo}/blob/main/docs/runbook.md"
  alert_actions = [aws_sns_topic.alerts.arn]
}

# ---------------------------------------------------------------------
# Web — ALB target 5xx / eligible requests (RequestCount − 4xx).
# ---------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "web_fast_burn" {
  alarm_name          = "${var.name_prefix}-web-fast-burn"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0.0144
  treat_missing_data  = "notBreaching"
  alarm_description = jsonencode({
    environment       = var.environment
    service           = "web"
    symptom           = "Web fast burn > 1.44%"
    slo_impact        = "Web load SLI; 28d budget 40m19s"
    observed          = "see NewStateReason"
    grafana_panel     = "${local.grafana_base}/d/tillflow-web?viewPanel=1"
    runbook           = "${local.runbook_base}#web-fast-burn"
    owner             = "Yordanos"
    first_safe_action = "Split ALB HTTPCode_Target_5XX vs HTTPCode_ELB_5XX for devops-g10-web-tg. Do not open the ALB."
  })
  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
  tags          = { service = "web" }

  metric_query {
    id          = "m5xx"
    return_data = false
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 300
      stat        = "Sum"
      dimensions = {
        LoadBalancer = aws_lb.app.arn_suffix
        TargetGroup  = aws_lb_target_group.web.arn_suffix
      }
    }
  }
  metric_query {
    id          = "mreq"
    return_data = false
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = 300
      stat        = "Sum"
      dimensions = {
        LoadBalancer = aws_lb.app.arn_suffix
        TargetGroup  = aws_lb_target_group.web.arn_suffix
      }
    }
  }
  metric_query {
    id          = "m4xx"
    return_data = false
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_4XX_Count"
      period      = 300
      stat        = "Sum"
      dimensions = {
        LoadBalancer = aws_lb.app.arn_suffix
        TargetGroup  = aws_lb_target_group.web.arn_suffix
      }
    }
  }
  metric_query {
    id          = "error_rate"
    expression  = "IF((mreq-m4xx)>0, m5xx/(mreq-m4xx), 0)"
    label       = "Web eligible 5xx rate"
    return_data = true
  }
}

resource "aws_cloudwatch_metric_alarm" "web_slow_burn" {
  alarm_name          = "${var.name_prefix}-web-slow-burn"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0.006
  treat_missing_data  = "notBreaching"
  alarm_description = jsonencode({
    environment       = var.environment
    service           = "web"
    symptom           = "Web slow burn > 0.6%"
    slo_impact        = "Web load SLI; 28d budget 40m19s (ticket, not page)"
    observed          = "see NewStateReason"
    grafana_panel     = "${local.grafana_base}/d/tillflow-web?viewPanel=1"
    runbook           = "${local.runbook_base}#web-slow-burn"
    owner             = "Yordanos"
    first_safe_action = "Same as web-fast-burn, but open a ticket. Split Target 5xx vs ELB 5xx."
  })
  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
  tags          = { service = "web" }

  metric_query {
    id          = "m5xx"
    return_data = false
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 1800
      stat        = "Sum"
      dimensions = {
        LoadBalancer = aws_lb.app.arn_suffix
        TargetGroup  = aws_lb_target_group.web.arn_suffix
      }
    }
  }
  metric_query {
    id          = "mreq"
    return_data = false
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = 1800
      stat        = "Sum"
      dimensions = {
        LoadBalancer = aws_lb.app.arn_suffix
        TargetGroup  = aws_lb_target_group.web.arn_suffix
      }
    }
  }
  metric_query {
    id          = "m4xx"
    return_data = false
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_4XX_Count"
      period      = 1800
      stat        = "Sum"
      dimensions = {
        LoadBalancer = aws_lb.app.arn_suffix
        TargetGroup  = aws_lb_target_group.web.arn_suffix
      }
    }
  }
  metric_query {
    id          = "error_rate"
    expression  = "IF((mreq-m4xx)>0, m5xx/(mreq-m4xx), 0)"
    label       = "Web eligible 5xx rate"
    return_data = true
  }
}

# ---------------------------------------------------------------------
# POS / Payments / Commission — TillFlow EMF.
# SEARCH is for Grafana only (AWS will not alarm on SEARCH; PutMetricAlarm
# then returns "Period must not be null"). Alarms use the awsemf
# ZeroAndSingleDimensionRollup series (exact label set from ADR-005).
# Denominator 0 (no traffic) is 0, not a burn.
# ---------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "pos_fast_burn" {
  alarm_name          = "${var.name_prefix}-pos-fast-burn"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0.0144
  treat_missing_data  = "notBreaching"
  alarm_description = jsonencode({
    environment       = var.environment
    service           = "pos"
    symptom           = "POS fast burn > 1.44%"
    slo_impact        = "POS sale-write SLI; 28d budget 40m19s"
    observed          = "see NewStateReason"
    grafana_panel     = "${local.grafana_base}/d/tillflow-pos?viewPanel=2"
    runbook           = "${local.runbook_base}#pos-fast-burn"
    owner             = "Berissa"
    first_safe_action = "curl POS /health then /ready. Do not bounce RDS."
  })
  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
  tags          = { service = "pos" }

  metric_query {
    id          = "e1"
    return_data = false
    metric {
      namespace   = "TillFlow"
      metric_name = "pos_sale_writes_total"
      period      = 300
      stat        = "Sum"
      dimensions  = { outcome = "error" }
    }
  }
  metric_query {
    id          = "e2"
    return_data = false
    metric {
      namespace   = "TillFlow"
      metric_name = "pos_sale_writes_total"
      period      = 300
      stat        = "Sum"
      dimensions  = { outcome = "created" }
    }
  }
  metric_query {
    id          = "e3"
    return_data = false
    metric {
      namespace   = "TillFlow"
      metric_name = "pos_sale_writes_total"
      period      = 300
      stat        = "Sum"
      dimensions  = { outcome = "replay" }
    }
  }
  metric_query {
    id          = "error_rate"
    expression  = "IF((e1+e2+e3)>0, e1/(e1+e2+e3), 0)"
    label       = "POS sale-write error rate"
    return_data = true
  }
}

resource "aws_cloudwatch_metric_alarm" "pos_slow_burn" {
  alarm_name          = "${var.name_prefix}-pos-slow-burn"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0.006
  treat_missing_data  = "notBreaching"
  alarm_description = jsonencode({
    environment       = var.environment
    service           = "pos"
    symptom           = "POS slow burn > 0.6%"
    slo_impact        = "POS sale-write SLI; 28d budget 40m19s (ticket, not page)"
    observed          = "see NewStateReason"
    grafana_panel     = "${local.grafana_base}/d/tillflow-pos?viewPanel=2"
    runbook           = "${local.runbook_base}#pos-slow-burn"
    owner             = "Berissa"
    first_safe_action = "curl POS /health then /ready. Ticket, not a page. Do not bounce RDS."
  })
  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
  tags          = { service = "pos" }

  metric_query {
    id          = "e1"
    return_data = false
    metric {
      namespace   = "TillFlow"
      metric_name = "pos_sale_writes_total"
      period      = 1800
      stat        = "Sum"
      dimensions  = { outcome = "error" }
    }
  }
  metric_query {
    id          = "e2"
    return_data = false
    metric {
      namespace   = "TillFlow"
      metric_name = "pos_sale_writes_total"
      period      = 1800
      stat        = "Sum"
      dimensions  = { outcome = "created" }
    }
  }
  metric_query {
    id          = "e3"
    return_data = false
    metric {
      namespace   = "TillFlow"
      metric_name = "pos_sale_writes_total"
      period      = 1800
      stat        = "Sum"
      dimensions  = { outcome = "replay" }
    }
  }
  metric_query {
    id          = "error_rate"
    expression  = "IF((e1+e2+e3)>0, e1/(e1+e2+e3), 0)"
    label       = "POS sale-write error rate"
    return_data = true
  }
}

resource "aws_cloudwatch_metric_alarm" "payments_fast_burn" {
  alarm_name          = "${var.name_prefix}-payments-fast-burn"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0.072
  treat_missing_data  = "notBreaching"
  alarm_description = jsonencode({
    environment       = var.environment
    service           = "payments"
    symptom           = "Payments fast burn > 7.2%"
    slo_impact        = "Payments STK/B2C SLI; 28d budget 3h21m36s"
    observed          = "see NewStateReason"
    grafana_panel     = "${local.grafana_base}/d/tillflow-payments?viewPanel=2"
    runbook           = "${local.runbook_base}#payments-fast-burn"
    owner             = "Arsema"
    first_safe_action = "Do not mark payments failed. Timeout stays pending until callback or reconcile."
  })
  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
  tags          = { service = "payments" }

  metric_query {
    id          = "t"
    return_data = false
    metric {
      namespace   = "TillFlow"
      metric_name = "payments_commands_total"
      period      = 300
      stat        = "Sum"
      dimensions  = { outcome = "timeout" }
    }
  }
  metric_query {
    id          = "a"
    return_data = false
    metric {
      namespace   = "TillFlow"
      metric_name = "payments_commands_total"
      period      = 300
      stat        = "Sum"
      dimensions  = { outcome = "accepted" }
    }
  }
  metric_query {
    id          = "error_rate"
    expression  = "IF((t+a)>0, t/(t+a), 0)"
    label       = "Payments timeout rate"
    return_data = true
  }
}

resource "aws_cloudwatch_metric_alarm" "payments_slow_burn" {
  alarm_name          = "${var.name_prefix}-payments-slow-burn"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0.03
  treat_missing_data  = "notBreaching"
  alarm_description = jsonencode({
    environment       = var.environment
    service           = "payments"
    symptom           = "Payments slow burn > 3%"
    slo_impact        = "Payments STK/B2C SLI; 28d budget 3h21m36s (ticket, not page)"
    observed          = "see NewStateReason"
    grafana_panel     = "${local.grafana_base}/d/tillflow-payments?viewPanel=2"
    runbook           = "${local.runbook_base}#payments-slow-burn"
    owner             = "Arsema"
    first_safe_action = "Do not mark payments failed. Ticket, not a page. Reconcile; never resend a charge."
  })
  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
  tags          = { service = "payments" }

  metric_query {
    id          = "t"
    return_data = false
    metric {
      namespace   = "TillFlow"
      metric_name = "payments_commands_total"
      period      = 1800
      stat        = "Sum"
      dimensions  = { outcome = "timeout" }
    }
  }
  metric_query {
    id          = "a"
    return_data = false
    metric {
      namespace   = "TillFlow"
      metric_name = "payments_commands_total"
      period      = 1800
      stat        = "Sum"
      dimensions  = { outcome = "accepted" }
    }
  }
  metric_query {
    id          = "error_rate"
    expression  = "IF((t+a)>0, t/(t+a), 0)"
    label       = "Payments timeout rate"
    return_data = true
  }
}

resource "aws_cloudwatch_metric_alarm" "commission_fast_burn" {
  alarm_name          = "${var.name_prefix}-commission-fast-burn"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0.144
  treat_missing_data  = "notBreaching"
  alarm_description = jsonencode({
    environment       = var.environment
    service           = "commission"
    symptom           = "Commission fast burn > 14.4%"
    slo_impact        = "Commission close SLI; 28d budget 0.28 late runs"
    observed          = "see NewStateReason"
    grafana_panel     = "${local.grafana_base}/d/tillflow-commission?viewPanel=2"
    runbook           = "${local.runbook_base}#commission-fast-burn"
    owner             = "Berissa"
    first_safe_action = "Confirm commission desiredCount >= 1. Do not replay daily close until the ledger row is in hand."
  })
  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
  tags          = { service = "commission" }

  metric_query {
    id          = "err"
    return_data = false
    metric {
      namespace   = "TillFlow"
      metric_name = "commission_close_runs_total"
      period      = 300
      stat        = "Sum"
      dimensions  = { outcome = "error" }
    }
  }
  metric_query {
    id          = "ok"
    return_data = false
    metric {
      namespace   = "TillFlow"
      metric_name = "commission_close_runs_total"
      period      = 300
      stat        = "Sum"
      dimensions  = { outcome = "success" }
    }
  }
  metric_query {
    id          = "error_rate"
    expression  = "IF((err+ok)>0, err/(err+ok), 0)"
    label       = "Commission close error rate"
    return_data = true
  }
}

resource "aws_cloudwatch_metric_alarm" "commission_slow_burn" {
  alarm_name          = "${var.name_prefix}-commission-slow-burn"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0.06
  treat_missing_data  = "notBreaching"
  alarm_description = jsonencode({
    environment       = var.environment
    service           = "commission"
    symptom           = "Commission slow burn > 6%"
    slo_impact        = "Commission close SLI; 28d budget 0.28 late runs (ticket, not page)"
    observed          = "see NewStateReason"
    grafana_panel     = "${local.grafana_base}/d/tillflow-commission?viewPanel=2"
    runbook           = "${local.runbook_base}#commission-slow-burn"
    owner             = "Berissa"
    first_safe_action = "Confirm commission desiredCount >= 1. Ticket, not a page. Do not replay close blindly."
  })
  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
  tags          = { service = "commission" }

  metric_query {
    id          = "err"
    return_data = false
    metric {
      namespace   = "TillFlow"
      metric_name = "commission_close_runs_total"
      period      = 1800
      stat        = "Sum"
      dimensions  = { outcome = "error" }
    }
  }
  metric_query {
    id          = "ok"
    return_data = false
    metric {
      namespace   = "TillFlow"
      metric_name = "commission_close_runs_total"
      period      = 1800
      stat        = "Sum"
      dimensions  = { outcome = "success" }
    }
  }
  metric_query {
    id          = "error_rate"
    expression  = "IF((err+ok)>0, err/(err+ok), 0)"
    label       = "Commission close error rate"
    return_data = true
  }
}

# ---------------------------------------------------------------------
# Probe, pending age, DLQs, saturation.
# ---------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "probe_down" {
  alarm_name          = "${var.name_prefix}-probe-down"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  threshold           = 100
  treat_missing_data  = "breaching"
  alarm_description = jsonencode({
    environment       = var.environment
    service           = "web"
    symptom           = "Probe down"
    slo_impact        = "Public uptime (canary devops-g10-probe)"
    observed          = "see NewStateReason"
    grafana_panel     = "${local.grafana_base}/d/tillflow-overview?viewPanel=1"
    runbook           = "${local.runbook_base}#probe-down"
    owner             = "Yordanos"
    first_safe_action = "Check API Gateway + WAF + VPC Link before blaming ECS. Canary hits the public Gateway."
  })
  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
  tags          = { service = "reliability" }

  namespace   = "CloudWatchSynthetics"
  metric_name = "SuccessPercent"
  statistic   = "Average"
  period      = 60
  dimensions = {
    CanaryName = aws_lambda_function.probe.function_name
  }
}

resource "aws_cloudwatch_metric_alarm" "payments_oldest_pending" {
  alarm_name          = "${var.name_prefix}-payments-oldest-pending"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 60
  treat_missing_data  = "notBreaching"
  alarm_description = jsonencode({
    environment       = var.environment
    service           = "payments"
    symptom           = "Oldest pending payment age > 60s"
    slo_impact        = "Callback-within-60s SLI; do not mark failed"
    observed          = "see NewStateReason"
    grafana_panel     = "${local.grafana_base}/d/tillflow-payments?viewPanel=5"
    runbook           = "${local.runbook_base}#payments-oldest-pending"
    owner             = "Arsema"
    first_safe_action = "Do not mark failed. List pending older than 60s and reconcile."
  })
  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
  tags          = { service = "payments" }

  metric_query {
    id          = "payment"
    return_data = false
    metric {
      namespace   = "TillFlow"
      metric_name = "payments_oldest_pending_age_seconds"
      period      = 60
      stat        = "Maximum"
      dimensions  = { kind = "payment" }
    }
  }
  metric_query {
    id          = "payout"
    return_data = false
    metric {
      namespace   = "TillFlow"
      metric_name = "payments_oldest_pending_age_seconds"
      period      = 60
      stat        = "Maximum"
      dimensions  = { kind = "payout" }
    }
  }
  metric_query {
    id          = "age"
    expression  = "MAX([payment, payout])"
    label       = "Oldest pending age seconds"
    return_data = true
  }
}

resource "aws_cloudwatch_metric_alarm" "commission_dlq" {
  alarm_name          = "${var.name_prefix}-commission-dlq"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_description = jsonencode({
    environment       = var.environment
    service           = "commission"
    symptom           = "Commission close DLQ is not empty"
    slo_impact        = "Close delivery; redrive can look like a second B2C"
    observed          = "see NewStateReason"
    grafana_panel     = "${local.grafana_base}/d/tillflow-commission?viewPanel=5"
    runbook           = "${local.runbook_base}#commission-dlq"
    owner             = "Berissa"
    first_safe_action = "Read devops-g10-commission-close-dlq. Do not redrive until the failure class is known."
  })
  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
  tags          = { service = "commission" }

  namespace   = "AWS/SQS"
  metric_name = "ApproximateNumberOfMessagesVisible"
  statistic   = "Maximum"
  period      = 60
  dimensions = {
    QueueName = aws_sqs_queue.commission_close_dlq.name
  }
}

resource "aws_cloudwatch_metric_alarm" "payments_callbacks_dlq" {
  alarm_name          = "${var.name_prefix}-payments-callbacks-dlq"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_description = jsonencode({
    environment       = var.environment
    service           = "payments"
    symptom           = "Payments callbacks DLQ is not empty"
    slo_impact        = "Callback processing; forged or poison messages"
    observed          = "see NewStateReason"
    grafana_panel     = "${local.grafana_base}/d/tillflow-payments?viewPanel=7"
    runbook           = "${local.runbook_base}#payments-callbacks-dlq"
    owner             = "Arsema"
    first_safe_action = "Read devops-g10-payments-callbacks-dlq. Do not redrive. Capture one sandbox body under evidence."
  })
  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
  tags          = { service = "payments" }

  namespace   = "AWS/SQS"
  metric_name = "ApproximateNumberOfMessagesVisible"
  statistic   = "Maximum"
  period      = 60
  dimensions = {
    QueueName = aws_sqs_queue.payments_callbacks_dlq.name
  }
}

resource "aws_cloudwatch_metric_alarm" "ecs_cpu_high" {
  alarm_name          = "${var.name_prefix}-ecs-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  threshold           = 70
  treat_missing_data  = "notBreaching"
  alarm_description = jsonencode({
    environment       = var.environment
    service           = "platform"
    symptom           = "ECS CPU > 70% (autoscale target)"
    slo_impact        = "Saturation; target tracking should hold 70%"
    observed          = "see NewStateReason"
    grafana_panel     = "${local.grafana_base}/d/tillflow-overview?viewPanel=10"
    runbook           = "${local.runbook_base}#ecs-cpu-high"
    owner             = "Yordanos"
    first_safe_action = "Confirm target tracking is 70% CPU. Do not change desired count in the console."
  })
  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
  tags          = { service = "platform" }

  metric_query {
    id          = "web"
    return_data = false
    metric {
      namespace   = "AWS/ECS"
      metric_name = "CPUUtilization"
      period      = 300
      stat        = "Average"
      dimensions = {
        ClusterName = aws_ecs_cluster.app.name
        ServiceName = aws_ecs_service.web.name
      }
    }
  }
  metric_query {
    id          = "pos"
    return_data = false
    metric {
      namespace   = "AWS/ECS"
      metric_name = "CPUUtilization"
      period      = 300
      stat        = "Average"
      dimensions = {
        ClusterName = aws_ecs_cluster.app.name
        ServiceName = aws_ecs_service.pos.name
      }
    }
  }
  metric_query {
    id          = "pay"
    return_data = false
    metric {
      namespace   = "AWS/ECS"
      metric_name = "CPUUtilization"
      period      = 300
      stat        = "Average"
      dimensions = {
        ClusterName = aws_ecs_cluster.app.name
        ServiceName = aws_ecs_service.payments.name
      }
    }
  }
  metric_query {
    id          = "comm"
    return_data = false
    metric {
      namespace   = "AWS/ECS"
      metric_name = "CPUUtilization"
      period      = 300
      stat        = "Average"
      dimensions = {
        ClusterName = aws_ecs_cluster.app.name
        ServiceName = aws_ecs_service.commission.name
      }
    }
  }
  metric_query {
    id          = "mx"
    expression  = "MAX([web, pos, pay, comm])"
    label       = "Max ECS CPU"
    return_data = true
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu_high" {
  alarm_name          = "${var.name_prefix}-rds-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  threshold           = 70
  treat_missing_data  = "notBreaching"
  alarm_description = jsonencode({
    environment       = var.environment
    service           = "platform"
    symptom           = "RDS CPU > 70%"
    slo_impact        = "Shared Postgres saturation"
    observed          = "see NewStateReason"
    grafana_panel     = "${local.grafana_base}/d/tillflow-overview"
    runbook           = "${local.runbook_base}#rds-cpu-high"
    owner             = "Yordanos"
    first_safe_action = "Performance Insights on devops-g10-pg. Do not failover (single-AZ). Do not change instance class in the console."
  })
  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
  tags          = { service = "platform" }

  namespace   = "AWS/RDS"
  metric_name = "CPUUtilization"
  statistic   = "Average"
  period      = 300
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.pg.identifier
  }
}

# ---------------------------------------------------------------------
# Payout not settled by 06:30 EAT = 03:30 UTC.
# EventBridge 03:31 UTC writes TillFlow/payouts_unsettled_after_cutoff
# (1 = still pending/disbursing, 0 = clear). Alarm period 1 day so a
# single put does not recover 60s later.
# ---------------------------------------------------------------------
data "aws_iam_policy_document" "payout_cutoff_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "payout_cutoff" {
  statement {
    sid       = "ReadPayoutGauges"
    effect    = "Allow"
    actions   = ["cloudwatch:GetMetricData"]
    resources = ["*"]
  }
  statement {
    sid       = "WriteCutoffMetric"
    effect    = "Allow"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["TillFlow"]
    }
  }
  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.payout_cutoff.arn}:*"]
  }
}

resource "aws_iam_role" "payout_cutoff" {
  name               = "${var.name_prefix}-payout-cutoff"
  description        = "Daily 06:30 EAT check: pending/disbursing payouts still > 0."
  assume_role_policy = data.aws_iam_policy_document.payout_cutoff_trust.json
  tags               = { service = "reliability" }
}

resource "aws_iam_policy" "payout_cutoff" {
  name   = "${var.name_prefix}-payout-cutoff"
  policy = data.aws_iam_policy_document.payout_cutoff.json
}

resource "aws_iam_role_policy_attachment" "payout_cutoff" {
  role       = aws_iam_role.payout_cutoff.name
  policy_arn = aws_iam_policy.payout_cutoff.arn
}

resource "aws_cloudwatch_log_group" "payout_cutoff" {
  name              = "/aws/lambda/${var.name_prefix}-payout-cutoff"
  retention_in_days = 30
  tags              = { service = "reliability" }
}

data "archive_file" "payout_cutoff" {
  type        = "zip"
  source_file = "${path.module}/lambda/payout_cutoff/index.py"
  output_path = "${path.module}/.build/payout_cutoff.zip"
}

resource "aws_lambda_function" "payout_cutoff" {
  function_name    = "${var.name_prefix}-payout-cutoff"
  role             = aws_iam_role.payout_cutoff.arn
  filename         = data.archive_file.payout_cutoff.output_path
  source_code_hash = data.archive_file.payout_cutoff.output_base64sha256
  handler          = "index.handler"
  runtime          = "python3.12"
  timeout          = 30
  memory_size      = 128

  tracing_config {
    mode = "PassThrough"
  }

  tags = { service = "reliability" }

  depends_on = [
    aws_iam_role_policy_attachment.payout_cutoff,
    aws_cloudwatch_log_group.payout_cutoff,
    aws_iam_policy.ci_deploy,
  ]
}

resource "aws_cloudwatch_event_rule" "payout_cutoff" {
  name                = "${var.name_prefix}-payout-cutoff"
  description         = "06:31 EAT — sample payouts_by_status after the 06:30 SLO cutoff."
  schedule_expression = "cron(31 3 * * ? *)"
  tags                = { service = "reliability" }
}

resource "aws_cloudwatch_event_target" "payout_cutoff" {
  rule = aws_cloudwatch_event_rule.payout_cutoff.name
  arn  = aws_lambda_function.payout_cutoff.arn
}

resource "aws_lambda_permission" "payout_cutoff" {
  statement_id  = "AllowEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.payout_cutoff.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.payout_cutoff.arn
}

resource "aws_cloudwatch_metric_alarm" "payout_not_settled" {
  alarm_name          = "${var.name_prefix}-payout-not-settled"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_description = jsonencode({
    environment       = var.environment
    service           = "commission"
    symptom           = "Payout not settled by 06:30 EAT"
    slo_impact        = "Eligible payouts terminal by 06:30 EAT; duplicate disbursement is an SLO miss with no budget"
    observed          = "see NewStateReason"
    grafana_panel     = "${local.grafana_base}/d/tillflow-commission?viewPanel=4"
    runbook           = "${local.runbook_base}#payout-not-settled"
    owner             = "Berissa + Arsema"
    first_safe_action = "Confirm daily close fired and desiredCount >= 1. Do not re-run close until the ledger row is in hand."
  })
  alarm_actions = local.alert_actions
  ok_actions    = local.alert_actions
  tags          = { service = "commission" }

  namespace   = "TillFlow"
  metric_name = "payouts_unsettled_after_cutoff"
  statistic   = "Maximum"
  period      = 86400
}
