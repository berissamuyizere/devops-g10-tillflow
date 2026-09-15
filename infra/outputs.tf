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
    web      = aws_ecs_service.web.name
    pos      = aws_ecs_service.pos.name
    payments = aws_ecs_service.payments.name
  }
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
