output "region" {
  value = var.region
}

output "account_id" {
  value = local.account_id
}

output "vpc_id" {
  value = module.vpc.vpc_id
}

output "private_subnets" {
  value = module.vpc.private_subnets
}

output "alb_dns_name" {
  description = "Internal ALB — reachable only from inside the VPC / API Gateway."
  value       = aws_lb.app.dns_name
}

output "api_gateway_url" {
  description = "Public HTTP endpoint for TillFlow."
  value       = aws_apigatewayv2_api.app.api_endpoint
}

output "ecr_repositories" {
  value = { for svc, repo in aws_ecr_repository.service : svc => repo.repository_url }
}

output "ci_deploy_role_arn" {
  description = "Assume this role from GitHub Actions via OIDC."
  value       = aws_iam_role.ci_deploy.arn
}

output "ecs_cluster" {
  value = aws_ecs_cluster.app.name
}

output "rds_endpoint" {
  value     = aws_db_instance.pg.address
  sensitive = false
}

output "valkey_endpoint" {
  value = aws_elasticache_replication_group.valkey.primary_endpoint_address
}

output "s3_buckets" {
  value = {
    artifacts = aws_s3_bucket.artifacts.bucket
    logs      = aws_s3_bucket.logs.bucket
    backups   = aws_s3_bucket.backups.bucket
  }
}

output "secrets" {
  value = {
    daraja         = aws_secretsmanager_secret.daraja.arn
    slack          = aws_secretsmanager_secret.slack.arn
    rds_master     = aws_secretsmanager_secret.rds_master.arn
    cache_auth     = aws_secretsmanager_secret.cache_auth.arn
    service_tokens = aws_secretsmanager_secret.service_tokens.arn
    db_pos         = aws_secretsmanager_secret.db_pos.arn
    db_payments    = aws_secretsmanager_secret.db_payments.arn
  }
}

output "ecs_services" {
  value = {
    web        = aws_ecs_service.web.name
    pos        = aws_ecs_service.pos.name
    payments   = aws_ecs_service.payments.name
    commission = aws_ecs_service.commission.name
  }
}

output "cpu_autoscale" {
  description = "Y6 — ECS CPU target tracking 70% (POS and Payments). Min 2, max 4."
  value = {
    for k, t in aws_appautoscaling_target.cpu : k => {
      resource_id  = t.resource_id
      min_capacity = t.min_capacity
      max_capacity = t.max_capacity
      policy       = aws_appautoscaling_policy.cpu[k].name
      target_value = 70
    }
  }
}

output "waf_rate_limit" {
  description = "WAF IP rate limit (requests per 5 minutes). Raise via GitHub WAF_RATE_LIMIT for k6, then set back to 200."
  value       = var.waf_rate_limit
}

output "commission_close_queue_url" {
  description = "SQS queue the Commission worker long-polls. No public ingress."
  value       = aws_sqs_queue.commission_close.url
}

output "db_bootstrap_task_family" {
  description = "Run once after apply: aws ecs run-task --task-definition <this>"
  value       = aws_ecs_task_definition.db_bootstrap.family
}

output "g2_base_urls" {
  description = "Happy-path base URLs (same API Gateway; ALB path-routes to each service)."
  value = {
    api_gateway  = aws_apigatewayv2_api.app.api_endpoint
    pos          = aws_apigatewayv2_api.app.api_endpoint
    payments     = aws_apigatewayv2_api.app.api_endpoint
    pos_internal = "http://${aws_lb.app.dns_name}"
  }
}

output "ecs_app_env_parameters" {
  description = "SSM documents release.yml merges into each app container on ECS roll."
  value       = { for svc, p in aws_ssm_parameter.ecs_app_env : svc => p.name }
}

output "grafana_url" {
  description = "Grafana Cloud (ADR-005). AMG g-ede3f6a694 is DELETION_FAILED; do not open it."
  value       = "https://punywaxwing1700.grafana.net"
}

output "probe_canary_name" {
  description = "Public /health + / probe. Dimension CanaryName on CloudWatchSynthetics SuccessPercent."
  value       = aws_lambda_function.probe.function_name
}

output "alerts_topic_arn" {
  description = "SNS topic CloudWatch alarms (Y5) publish to. Lambda posts Slack firing and recovered."
  value       = aws_sns_topic.alerts.arn
}

output "slack_notifier_function_name" {
  value = aws_lambda_function.slack_notifier.function_name
}

output "alarm_names" {
  description = "Y5 CloudWatch alarms from docs/alerts.md. Alarm + OK both go to devops-g10-alerts."
  value = [
    aws_cloudwatch_metric_alarm.web_fast_burn.alarm_name,
    aws_cloudwatch_metric_alarm.web_slow_burn.alarm_name,
    aws_cloudwatch_metric_alarm.pos_fast_burn.alarm_name,
    aws_cloudwatch_metric_alarm.pos_slow_burn.alarm_name,
    aws_cloudwatch_metric_alarm.payments_fast_burn.alarm_name,
    aws_cloudwatch_metric_alarm.payments_slow_burn.alarm_name,
    aws_cloudwatch_metric_alarm.commission_fast_burn.alarm_name,
    aws_cloudwatch_metric_alarm.commission_slow_burn.alarm_name,
    aws_cloudwatch_metric_alarm.probe_down.alarm_name,
    aws_cloudwatch_metric_alarm.payments_oldest_pending.alarm_name,
    aws_cloudwatch_metric_alarm.commission_dlq.alarm_name,
    aws_cloudwatch_metric_alarm.payout_not_settled.alarm_name,
    aws_cloudwatch_metric_alarm.payments_callbacks_dlq.alarm_name,
    aws_cloudwatch_metric_alarm.ecs_cpu_high.alarm_name,
    aws_cloudwatch_metric_alarm.rds_cpu_high.alarm_name,
  ]
}
