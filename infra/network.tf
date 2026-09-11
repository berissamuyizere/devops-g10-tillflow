# VPC with 2 AZs, public subnets for ALB + NAT, private subnets for ECS/RDS/cache.
# Uses the community VPC module — well-tested, saves ~200 LOC of hand-rolled
# subnet/route/NAT wiring.

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.13"

  name = "${var.name_prefix}-vpc"
  cidr = "10.20.0.0/16"

  azs              = local.azs
  public_subnets   = ["10.20.0.0/24", "10.20.1.0/24"]
  private_subnets  = ["10.20.10.0/24", "10.20.11.0/24"]
  database_subnets = ["10.20.20.0/24", "10.20.21.0/24"]

  enable_nat_gateway     = true
  single_nat_gateway     = true # capstone cost; production would be one per AZ
  one_nat_gateway_per_az = false

  enable_dns_hostnames = true
  enable_dns_support   = true

  create_database_subnet_group = true

  # Flow logs to CloudWatch. IAM role is created below with the devops-g10-
  # prefix because this SSO role cannot iam:CreateRole on unprefixed names.
  enable_flow_log                      = true
  create_flow_log_cloudwatch_iam_role  = false
  create_flow_log_cloudwatch_log_group = true
  flow_log_cloudwatch_iam_role_arn     = aws_iam_role.vpc_flow.arn
  flow_log_max_aggregation_interval    = 60

  tags = {
    service = "network"
  }
}

data "aws_iam_policy_document" "vpc_flow_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "vpc_flow" {
  name               = "${var.name_prefix}-vpc-flow-logs"
  description        = "VPC flow logs to CloudWatch."
  assume_role_policy = data.aws_iam_policy_document.vpc_flow_assume.json
  tags               = { service = "network" }
}

resource "aws_iam_role_policy" "vpc_flow" {
  name = "${var.name_prefix}-vpc-flow-logs"
  role = aws_iam_role.vpc_flow.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
      ]
      Resource = "*"
    }]
  })
}

# VPC endpoints so ECS tasks can pull from ECR / write to CloudWatch / read
# Secrets Manager without leaving the VPC. Cheaper than NAT egress at scale
# and required for a private-subnet task to boot.
module "vpc_endpoints" {
  source  = "terraform-aws-modules/vpc/aws//modules/vpc-endpoints"
  version = "~> 5.13"

  vpc_id             = module.vpc.vpc_id
  security_group_ids = [aws_security_group.vpc_endpoints.id]

  endpoints = {
    s3 = {
      service         = "s3"
      service_type    = "Gateway"
      route_table_ids = module.vpc.private_route_table_ids
      tags            = { Name = "${var.name_prefix}-vpce-s3" }
    }
    ecr_api = {
      service             = "ecr.api"
      private_dns_enabled = true
      subnet_ids          = module.vpc.private_subnets
      tags                = { Name = "${var.name_prefix}-vpce-ecr-api" }
    }
    ecr_dkr = {
      service             = "ecr.dkr"
      private_dns_enabled = true
      subnet_ids          = module.vpc.private_subnets
      tags                = { Name = "${var.name_prefix}-vpce-ecr-dkr" }
    }
    logs = {
      service             = "logs"
      private_dns_enabled = true
      subnet_ids          = module.vpc.private_subnets
      tags                = { Name = "${var.name_prefix}-vpce-logs" }
    }
    secretsmanager = {
      service             = "secretsmanager"
      private_dns_enabled = true
      subnet_ids          = module.vpc.private_subnets
      tags                = { Name = "${var.name_prefix}-vpce-secrets" }
    }
    ssm = {
      service             = "ssm"
      private_dns_enabled = true
      subnet_ids          = module.vpc.private_subnets
      tags                = { Name = "${var.name_prefix}-vpce-ssm" }
    }
  }

  tags = {
    service = "network"
  }
}
