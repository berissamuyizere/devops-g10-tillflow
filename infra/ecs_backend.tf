# G2: POS + Payments Fargate services (same golden path as web).
# First apply uses busybox /health placeholders; release.yml swaps digests.

locals {
  backend_placeholder_image = "public.ecr.aws/docker/library/busybox:1.37.0"

  pos_uses_placeholder      = var.pos_image_digest == null
  payments_uses_placeholder = var.payments_image_digest == null

  pos_image      = coalesce(var.pos_image_digest, local.backend_placeholder_image)
  payments_image = coalesce(var.payments_image_digest, local.backend_placeholder_image)

  # Placeholder only serves /health (ALB + ECS probes). Real images clear
  # this command in release.yml via del(.command).
  pos_placeholder_command = [
    "sh", "-c",
    "mkdir -p /tmp/www && printf '%s\\n' '{\"status\":\"ok\",\"service\":\"pos\"}' > /tmp/www/health && exec httpd -f -p 8080 -h /tmp/www",
  ]
  payments_placeholder_command = [
    "sh", "-c",
    "mkdir -p /tmp/www && printf '%s\\n' '{\"status\":\"ok\",\"service\":\"payments\"}' > /tmp/www/health && exec httpd -f -p 8080 -h /tmp/www",
  ]

  # Payments reaches POS through the internal ALB (path rules), not public API GW.
  pos_base_url_internal = "http://${aws_lb.app.dns_name}"
  daraja_callback_url   = "${aws_apigatewayv2_api.app.api_endpoint}/payments/callback"
}

# ---------------------------------------------------------------------
# Log groups
# ---------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "pos" {
  name              = "/${var.name_prefix}/pos"
  retention_in_days = 30
  tags              = { service = "pos" }
}

resource "aws_cloudwatch_log_group" "adot_pos" {
  name              = "/${var.name_prefix}/adot/pos"
  retention_in_days = 30
  tags              = { service = "pos", role = "adot-sidecar" }
}

resource "aws_cloudwatch_log_group" "payments" {
  name              = "/${var.name_prefix}/payments"
  retention_in_days = 30
  tags              = { service = "payments" }
}

resource "aws_cloudwatch_log_group" "adot_payments" {
  name              = "/${var.name_prefix}/adot/payments"
  retention_in_days = 30
  tags              = { service = "payments", role = "adot-sidecar" }
}

# ---------------------------------------------------------------------
# POS task + service
# ---------------------------------------------------------------------
resource "aws_ecs_task_definition" "pos" {
  family                   = "${var.name_prefix}-pos"
  cpu                      = 512
  memory                   = 1024
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]

  execution_role_arn = aws_iam_role.task_exec["pos"].arn
  task_role_arn      = aws_iam_role.task["pos"].arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    merge(
      {
        name                   = "app"
        image                  = local.pos_image
        essential              = true
        readonlyRootFilesystem = true
        user                   = "10001:10001"
        portMappings = [
          { containerPort = 8080, protocol = "tcp" },
        ]
        environment = local.ecs_app_env.pos.environment
        secrets     = local.ecs_app_env.pos.secrets
        mountPoints = [
          { sourceVolume = "tmp", containerPath = "/tmp", readOnly = false },
        ]
        dependsOn = [
          { containerName = "adot", condition = "HEALTHY" },
        ]
        logConfiguration = {
          logDriver = "awslogs"
          options = {
            awslogs-group         = aws_cloudwatch_log_group.pos.name
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
      local.pos_uses_placeholder ? { command = local.pos_placeholder_command } : {}
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
          awslogs-group         = aws_cloudwatch_log_group.adot_pos.name
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
    service = "pos"
  }

  lifecycle {
    ignore_changes = [container_definitions]
  }
}

resource "aws_ecs_service" "pos" {
  name             = "${var.name_prefix}-pos"
  cluster          = aws_ecs_cluster.app.id
  task_definition  = aws_ecs_task_definition.pos.arn
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
    target_group_arn = aws_lb_target_group.pos.arn
    container_name   = "app"
    container_port   = 8080
  }

  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [
    aws_lb_listener_rule.pos_sales,
    aws_lb_listener_rule.pos_internal_sales,
  ]

  tags = {
    service = "pos"
  }
}

# ---------------------------------------------------------------------
# Payments task + service
# ---------------------------------------------------------------------
resource "aws_ecs_task_definition" "payments" {
  family                   = "${var.name_prefix}-payments"
  cpu                      = 512
  memory                   = 1024
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]

  execution_role_arn = aws_iam_role.task_exec["payments"].arn
  task_role_arn      = aws_iam_role.task["payments"].arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    merge(
      {
        name                   = "app"
        image                  = local.payments_image
        essential              = true
        readonlyRootFilesystem = true
        user                   = "10001:10001"
        portMappings = [
          { containerPort = 8080, protocol = "tcp" },
        ]
        environment = local.ecs_app_env.payments.environment
        secrets     = local.ecs_app_env.payments.secrets
        mountPoints = [
          { sourceVolume = "tmp", containerPath = "/tmp", readOnly = false },
        ]
        dependsOn = [
          { containerName = "adot", condition = "HEALTHY" },
        ]
        logConfiguration = {
          logDriver = "awslogs"
          options = {
            awslogs-group         = aws_cloudwatch_log_group.payments.name
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
      local.payments_uses_placeholder ? { command = local.payments_placeholder_command } : {}
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
          awslogs-group         = aws_cloudwatch_log_group.adot_payments.name
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
    service = "payments"
  }

  lifecycle {
    ignore_changes = [container_definitions]
  }
}

resource "aws_ecs_service" "payments" {
  name             = "${var.name_prefix}-payments"
  cluster          = aws_ecs_cluster.app.id
  task_definition  = aws_ecs_task_definition.payments.arn
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
    target_group_arn = aws_lb_target_group.payments.arn
    container_name   = "app"
    container_port   = 8080
  }

  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [
    aws_lb_listener_rule.payments_callback,
    aws_lb_listener_rule.payments_charges,
    aws_ecs_service.pos,
  ]

  tags = {
    service = "payments"
  }
}
