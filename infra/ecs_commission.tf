# G2 HOLD: Commission close worker (SQS consumer, no public ALB).
# EventBridge already enqueues devops-g10-commission-close. This task is the
# missing actor. It never receives Daraja credentials (ADR-002).

locals {
  commission_uses_placeholder = var.commission_image_digest == null
  commission_image            = coalesce(var.commission_image_digest, local.backend_placeholder_image)

  commission_placeholder_command = [
    "sh", "-c",
    "mkdir -p /tmp/www && printf '%s\\n' '{\"status\":\"ok\",\"service\":\"commission\"}' > /tmp/www/health && exec httpd -f -p 8080 -h /tmp/www",
  ]
}

resource "aws_cloudwatch_log_group" "commission" {
  name              = "/${var.name_prefix}/commission"
  retention_in_days = 30
  tags              = { service = "commission" }
}

resource "aws_cloudwatch_log_group" "adot_commission" {
  name              = "/${var.name_prefix}/adot/commission"
  retention_in_days = 30
  tags              = { service = "commission", role = "adot-sidecar" }
}

resource "aws_ecs_task_definition" "commission" {
  family                   = "${var.name_prefix}-commission"
  cpu                      = 512
  memory                   = 1024
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]

  execution_role_arn = aws_iam_role.task_exec["commission"].arn
  task_role_arn      = aws_iam_role.task["commission"].arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    merge(
      {
        name                   = "app"
        image                  = local.commission_image
        essential              = true
        readonlyRootFilesystem = true
        user                   = "10001:10001"
        portMappings = [
          { containerPort = 8080, protocol = "tcp" },
        ]
        environment = local.ecs_app_env.commission.environment
        secrets     = local.ecs_app_env.commission.secrets
        mountPoints = [
          { sourceVolume = "tmp", containerPath = "/tmp", readOnly = false },
        ]
        dependsOn = [
          { containerName = "adot", condition = "HEALTHY" },
        ]
        logConfiguration = {
          logDriver = "awslogs"
          options = {
            awslogs-group         = aws_cloudwatch_log_group.commission.name
            awslogs-region        = var.region
            awslogs-stream-prefix = "app"
          }
        }
        linuxParameters = { initProcessEnabled = true }
        healthCheck = {
          command     = ["CMD-SHELL", "wget -qO- http://127.0.0.1:8080/health || exit 1"]
          interval    = 10
          timeout     = 3
          retries     = 3
          startPeriod = 20
        }
      },
      local.commission_uses_placeholder ? { command = local.commission_placeholder_command } : {}
    ),
    {
      name                   = "adot"
      image                  = var.adot_collector_image
      essential              = false
      readonlyRootFilesystem = true
      command                = ["--config=env:AOT_CONFIG_CONTENT"]
      linuxParameters        = { initProcessEnabled = true }
      environment = [
        { name = "AOT_CONFIG_CONTENT", value = aws_ssm_parameter.adot_config.value },
      ]
      mountPoints = [
        { sourceVolume = "tmp", containerPath = "/tmp", readOnly = false },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.adot_commission.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "adot"
        }
      }
      healthCheck = {
        command     = ["CMD", "/healthcheck"]
        interval    = 10
        timeout     = 5
        retries     = 5
        startPeriod = 30
      }
    },
  ])

  volume {
    name = "tmp"
  }

  tags = {
    service = "commission"
  }

  lifecycle {
    ignore_changes = [container_definitions]
  }
}

resource "aws_ecs_service" "commission" {
  name             = "${var.name_prefix}-commission"
  cluster          = aws_ecs_cluster.app.id
  task_definition  = aws_ecs_task_definition.commission.arn
  desired_count    = 1
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

  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [
    aws_ecs_service.pos,
    aws_ecs_service.payments,
    aws_sqs_queue_policy.commission_close,
  ]

  tags = {
    service = "commission"
  }
}
