# ECS Fargate cluster + `web` golden-path service.
# POS / Payments / Commission task definitions land in G2 following the same
# shape as `web` here.

resource "aws_ecs_cluster" "app" {
  name = var.name_prefix

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    service = "ecs"
  }
}

resource "aws_ecs_cluster_capacity_providers" "app" {
  cluster_name       = aws_ecs_cluster.app.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/${var.name_prefix}/web"
  retention_in_days = 30
  tags              = { service = "web" }
}

resource "aws_cloudwatch_log_group" "adot_web" {
  name              = "/${var.name_prefix}/adot/web"
  retention_in_days = 30
  tags              = { service = "web", role = "adot-sidecar" }
}

# ADOT collector config lives in SSM so the sidecar can read it at start.
# G3 (Saloi) tunes exporters here; for G1 it is a working minimal config.
resource "aws_ssm_parameter" "adot_config" {
  name        = "/${var.name_prefix}/adot/config"
  description = "Shared ADOT collector config. Consumed by every backend task."
  type        = "String"
  tier        = "Standard"

  value = <<-EOT
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318
    processors:
      batch:
        timeout: 5s
    exporters:
      awsxray:
        region: ${var.region}
      awsemf:
        region: ${var.region}
        namespace: TillFlow
        log_group_name: /${var.name_prefix}/adot/metrics
    extensions:
      health_check:
        endpoint: 0.0.0.0:13133
    service:
      extensions: [health_check]
      pipelines:
        traces:
          receivers: [otlp]
          processors: [batch]
          exporters: [awsxray]
        metrics:
          receivers: [otlp]
          processors: [batch]
          exporters: [awsemf]
  EOT

  tags = { service = "adot" }
}

resource "aws_cloudwatch_log_group" "adot_metrics" {
  name              = "/${var.name_prefix}/adot/metrics"
  retention_in_days = 30
  tags              = { service = "adot" }
}

# ---------------------------------------------------------------------
# Web task definition.
# `web_image_digest` is null on first apply — we launch a placeholder
# nginx so the task boots and passes /health via the ALB, then the
# pipeline replaces it with our built image and re-registers the task
# def.
# ---------------------------------------------------------------------
locals {
  web_image = coalesce(
    var.web_image_digest,
    "public.ecr.aws/nginx/nginx:1.27-alpine-slim"
  )
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name_prefix}-web"
  cpu                      = 512
  memory                   = 1024
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]

  execution_role_arn = aws_iam_role.task_exec["web"].arn
  task_role_arn      = aws_iam_role.task["web"].arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name                   = "app"
      image                  = local.web_image
      essential              = true
      readonlyRootFilesystem = true
      user                   = "10001:10001"
      portMappings = [
        { containerPort = 8080, protocol = "tcp" },
      ]
      environment = [
        { name = "PORT", value = "8080" },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://localhost:4318" },
        { name = "OTEL_SERVICE_NAME", value = "web" },
        { name = "OTEL_RESOURCE_ATTRIBUTES", value = "service.namespace=tillflow,deployment.environment=${var.environment}" },
        { name = "LOG_LEVEL", value = "info" },
      ]
      mountPoints = [
        { sourceVolume = "tmp", containerPath = "/tmp", readOnly = false },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.web.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "app"
        }
      }
      healthCheck = {
        command     = ["CMD-SHELL", "wget -qO- http://127.0.0.1:8080/health || exit 1"]
        interval    = 10
        timeout     = 3
        retries     = 3
        startPeriod = 20
      }
    },
    {
      name                   = "adot"
      image                  = var.adot_collector_image
      essential              = false
      readonlyRootFilesystem = true
      user                   = "10001:10001"
      command                = ["--config=env:AOT_CONFIG_CONTENT"]
      environment = [
        { name = "AOT_CONFIG_CONTENT", value = aws_ssm_parameter.adot_config.value },
      ]
      mountPoints = [
        { sourceVolume = "tmp", containerPath = "/tmp", readOnly = false },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.adot_web.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "adot"
        }
      }
    },
  ])

  volume {
    name = "tmp"
  }

  tags = {
    service = "web"
  }

  lifecycle {
    # The pipeline updates image; don't drift-check the container_definitions
    # field once the pipeline is live.
    ignore_changes = [container_definitions]
  }
}

resource "aws_ecs_service" "web" {
  name             = "${var.name_prefix}-web"
  cluster          = aws_ecs_cluster.app.id
  task_definition  = aws_ecs_task_definition.web.arn
  desired_count    = 2
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = module.vpc.private_subnets
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "app"
    container_port   = 8080
  }

  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  # Pipeline is the source of truth for the task definition after G1.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener.http]

  tags = {
    service = "web"
  }
}
