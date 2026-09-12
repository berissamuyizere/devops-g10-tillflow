# Security groups. Kept in one file so the ingress/egress story is auditable.
# Named ports only — no wildcard 0.0.0.0/0 except where explicitly required.
#
# Path: API Gateway → VPC Link ENIs → ALB:80 → ECS tasks:8080.
# Each hop has its own SG. Do not reuse the ALB SG on the VPC Link:
# that SG's egress is ECS:8080 only, so the Link ENIs cannot reach the
# ALB listener and the public API returns 503.

# ---------------------------------------------------------------------
# API Gateway VPC Link ENIs — initiate HTTP to the internal ALB only.
# ---------------------------------------------------------------------
resource "aws_security_group" "vpclink" {
  name        = "${var.name_prefix}-vpclink"
  description = "API Gateway VPC Link ENIs; egress to internal ALB only."
  vpc_id      = module.vpc.vpc_id

  tags = {
    Name    = "${var.name_prefix}-vpclink"
    service = "api-gateway"
  }
}

resource "aws_vpc_security_group_egress_rule" "vpclink_to_alb" {
  security_group_id            = aws_security_group.vpclink.id
  description                  = "VPC Link ENIs to ALB HTTP listener."
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 80
  to_port                      = 80
  ip_protocol                  = "tcp"
}

# ---------------------------------------------------------------------
# ALB — reachable only from API Gateway VPC Link ENIs.
# ---------------------------------------------------------------------
resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb"
  description = "Internal ALB; accepts traffic from API Gateway VPC Link only."
  vpc_id      = module.vpc.vpc_id

  tags = {
    Name    = "${var.name_prefix}-alb"
    service = "alb"
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_vpclink" {
  security_group_id            = aws_security_group.alb.id
  description                  = "HTTP from API Gateway VPC Link ENIs."
  referenced_security_group_id = aws_security_group.vpclink.id
  from_port                    = 80
  to_port                      = 80
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_ecs" {
  security_group_id            = aws_security_group.alb.id
  description                  = "ALB to ECS task app port only."
  referenced_security_group_id = aws_security_group.ecs_tasks.id
  from_port                    = 8080
  to_port                      = 8080
  ip_protocol                  = "tcp"
}

# ---------------------------------------------------------------------
# ECS tasks — accept from ALB SG only; egress open (needs to hit RDS,
# cache, Secrets Manager, ECR endpoints, Daraja sandbox).
# ---------------------------------------------------------------------
resource "aws_security_group" "ecs_tasks" {
  name        = "${var.name_prefix}-ecs-tasks"
  description = "Application containers on ECS Fargate."
  vpc_id      = module.vpc.vpc_id

  tags = {
    Name    = "${var.name_prefix}-ecs-tasks"
    service = "ecs"
  }
}

resource "aws_vpc_security_group_ingress_rule" "ecs_from_alb" {
  security_group_id            = aws_security_group.ecs_tasks.id
  description                  = "Traffic from ALB to app port."
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 8080
  to_port                      = 8080
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "ecs_all" {
  security_group_id = aws_security_group.ecs_tasks.id
  description       = "Egress to RDS / cache / Secrets / ECR / Daraja."
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# ---------------------------------------------------------------------
# RDS — from ECS task SG only.
# ---------------------------------------------------------------------
resource "aws_security_group" "rds" {
  name        = "${var.name_prefix}-rds"
  description = "PostgreSQL; accepts from ECS task SG only."
  vpc_id      = module.vpc.vpc_id

  tags = {
    Name    = "${var.name_prefix}-rds"
    service = "rds"
  }
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_ecs" {
  security_group_id            = aws_security_group.rds.id
  description                  = "PostgreSQL from ECS tasks."
  referenced_security_group_id = aws_security_group.ecs_tasks.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

# ---------------------------------------------------------------------
# ElastiCache Valkey — from ECS task SG only.
# ---------------------------------------------------------------------
resource "aws_security_group" "cache" {
  name        = "${var.name_prefix}-cache"
  description = "Valkey; accepts from ECS task SG only."
  vpc_id      = module.vpc.vpc_id

  tags = {
    Name    = "${var.name_prefix}-cache"
    service = "cache"
  }
}

resource "aws_vpc_security_group_ingress_rule" "cache_from_ecs" {
  security_group_id            = aws_security_group.cache.id
  description                  = "Valkey from ECS tasks."
  referenced_security_group_id = aws_security_group.ecs_tasks.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

# ---------------------------------------------------------------------
# VPC endpoints SG — HTTPS from ECS tasks.
# ---------------------------------------------------------------------
resource "aws_security_group" "vpc_endpoints" {
  name        = "${var.name_prefix}-vpce"
  description = "Interface VPC endpoints; HTTPS from ECS task SG."
  vpc_id      = module.vpc.vpc_id

  tags = {
    Name    = "${var.name_prefix}-vpce"
    service = "network"
  }
}

resource "aws_vpc_security_group_ingress_rule" "vpce_https_from_ecs" {
  security_group_id            = aws_security_group.vpc_endpoints.id
  description                  = "HTTPS from ECS tasks."
  referenced_security_group_id = aws_security_group.ecs_tasks.id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
}
