# App-container env overlay (G3 Y1).
#
# Task definitions ignore_changes = [container_definitions], so a terraform
# apply never updates running tasks. release.yml copies the *live* task def
# and only swapped the image. New env/secrets never arrived.
#
# Terraform now writes the full app environment + secrets to
# /devops-g10/<service>/env. On every ECS roll, release.yml replaces the
# app container's environment/secrets with that document (then stamps
# COMMIT_SHA / IMAGE_DIGEST). Add a key here and the next Release picks it up.

locals {
  ecs_app_env = {
    web = {
      environment = [
        { name = "PORT", value = "8080" },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://localhost:4318" },
        { name = "OTEL_SERVICE_NAME", value = "web" },
        { name = "OTEL_RESOURCE_ATTRIBUTES", value = "service.namespace=tillflow,deployment.environment=${var.environment}" },
        { name = "LOG_LEVEL", value = "info" },
      ]
      secrets = []
    }

    pos = {
      environment = [
        { name = "PORT", value = "8080" },
        { name = "AWS_REGION", value = var.region },
        { name = "DB_SECRET_ID", value = aws_secretsmanager_secret.db_pos.name },
        { name = "DB_SCHEMA", value = "pos" },
        { name = "PAYMENTS_BASE_URL", value = local.pos_base_url_internal },
        { name = "CACHE_HOST", value = aws_elasticache_replication_group.valkey.primary_endpoint_address },
        { name = "CACHE_PORT", value = "6379" },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://localhost:4318" },
        { name = "OTEL_SERVICE_NAME", value = "pos" },
        { name = "OTEL_RESOURCE_ATTRIBUTES", value = "service.namespace=tillflow,deployment.environment=${var.environment}" },
        { name = "LOG_LEVEL", value = "info" },
        { name = "DEPLOYMENT_ENVIRONMENT", value = var.environment },
      ]
      secrets = [
        {
          name      = "PAYMENTS_SERVICE_TOKEN"
          valueFrom = "${aws_secretsmanager_secret.service_tokens.arn}:payments_service_token::"
        },
        {
          name      = "CACHE_AUTH_TOKEN"
          valueFrom = "${aws_secretsmanager_secret.cache_auth.arn}:auth_token::"
        },
      ]
    }

    payments = {
      environment = [
        { name = "PORT", value = "8080" },
        { name = "AWS_REGION", value = var.region },
        { name = "DB_SECRET_ID", value = aws_secretsmanager_secret.db_payments.name },
        { name = "DB_SCHEMA", value = "payments" },
        { name = "MPESA_MODE", value = "fake" },
        { name = "POS_BASE_URL", value = local.pos_base_url_internal },
        { name = "DARAJA_CALLBACK_URL", value = local.daraja_callback_url },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://localhost:4318" },
        { name = "OTEL_SERVICE_NAME", value = "payments" },
        { name = "OTEL_RESOURCE_ATTRIBUTES", value = "service.namespace=tillflow,deployment.environment=${var.environment}" },
        { name = "LOG_LEVEL", value = "info" },
        { name = "DEPLOYMENT_ENVIRONMENT", value = var.environment },
      ]
      secrets = [
        {
          name      = "PAYMENTS_SERVICE_TOKEN"
          valueFrom = "${aws_secretsmanager_secret.service_tokens.arn}:payments_service_token::"
        },
        {
          name      = "POS_SERVICE_TOKEN"
          valueFrom = "${aws_secretsmanager_secret.service_tokens.arn}:pos_service_token::"
        },
        {
          name      = "COMMISSION_SERVICE_TOKEN"
          valueFrom = "${aws_secretsmanager_secret.service_tokens.arn}:commission_service_token::"
        },
        {
          name      = "DARAJA_CALLBACK_SECRET"
          valueFrom = "${aws_secretsmanager_secret.service_tokens.arn}:daraja_callback_secret::"
        },
      ]
    }

    commission = {
      environment = [
        { name = "PORT", value = "8080" },
        { name = "AWS_REGION", value = var.region },
        { name = "SQS_QUEUE_URL", value = aws_sqs_queue.commission_close.url },
        { name = "POS_BASE_URL", value = local.pos_base_url_internal },
        { name = "PAYMENTS_BASE_URL", value = local.pos_base_url_internal },
        { name = "COMMISSION_TENANT_IDS", value = "11111111-1111-1111-1111-111111111111" },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://localhost:4318" },
        { name = "OTEL_SERVICE_NAME", value = "commission" },
        { name = "OTEL_RESOURCE_ATTRIBUTES", value = "service.namespace=tillflow,deployment.environment=${var.environment}" },
        { name = "LOG_LEVEL", value = "info" },
        { name = "DEPLOYMENT_ENVIRONMENT", value = var.environment },
      ]
      secrets = [
        {
          name      = "PAYMENTS_SERVICE_TOKEN"
          valueFrom = "${aws_secretsmanager_secret.service_tokens.arn}:payments_service_token::"
        },
        {
          name      = "COMMISSION_SERVICE_TOKEN"
          valueFrom = "${aws_secretsmanager_secret.service_tokens.arn}:commission_service_token::"
        },
      ]
    }
  }
}

resource "aws_ssm_parameter" "ecs_app_env" {
  for_each = local.ecs_app_env

  name        = "/${var.name_prefix}/${each.key}/env"
  description = "App container environment + secrets. release.yml applies this on every ECS roll."
  type        = "String"
  value       = jsonencode(each.value)

  tags = {
    service = each.key
  }
}
