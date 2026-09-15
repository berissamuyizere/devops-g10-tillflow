# One-off DB bootstrap task (ADR-003).
# Release runs: aws ecs run-task --task-definition devops-g10-db-bootstrap
# then migrate with the pos/payments app images (node bin/migrate.js up).

resource "aws_cloudwatch_log_group" "db_migrate" {
  name              = "/${var.name_prefix}/db-migrate"
  retention_in_days = 30
  tags              = { service = "platform", role = "db-migrate" }
}

resource "aws_iam_role" "db_migrate_exec" {
  name               = "${var.name_prefix}-db-migrate-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_trust.json
  tags               = { service = "platform" }
}

resource "aws_iam_role_policy_attachment" "db_migrate_exec_default" {
  role       = aws_iam_role.db_migrate_exec.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "db_migrate_exec" {
  statement {
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.rds_master.arn,
      aws_secretsmanager_secret.db_pos.arn,
      aws_secretsmanager_secret.db_payments.arn,
    ]
  }
}

resource "aws_iam_role_policy" "db_migrate_exec" {
  name   = "${var.name_prefix}-db-migrate-exec"
  role   = aws_iam_role.db_migrate_exec.id
  policy = data.aws_iam_policy_document.db_migrate_exec.json
}

locals {
  db_bootstrap_script = <<-SCRIPT
    set -euo pipefail
    export PGSSLMODE=require
    export PGPASSWORD="$MASTER_PASSWORD"
    psql -h "$MASTER_HOST" -p "$MASTER_PORT" -U "$MASTER_USER" -d "$MASTER_DB" \
      -v ON_ERROR_STOP=1 \
      -v pos_user="$POS_USER" \
      -v pos_pass="$POS_PASSWORD" \
      -v pay_user="$PAY_USER" \
      -v pay_pass="$PAY_PASSWORD" <<'SQL'
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE SCHEMA IF NOT EXISTS pos;
    CREATE SCHEMA IF NOT EXISTS payments;

    SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'pos_user', :'pos_pass')
      WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'pos_user')\gexec
    SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'pos_user', :'pos_pass')
      WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = :'pos_user')\gexec

    SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'pay_user', :'pay_pass')
      WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'pay_user')\gexec
    SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'pay_user', :'pay_pass')
      WHERE EXISTS (SELECT FROM pg_roles WHERE rolname = :'pay_user')\gexec

    GRANT USAGE, CREATE ON SCHEMA pos TO :"pos_user";
    GRANT USAGE, CREATE ON SCHEMA payments TO :"pay_user";
    ALTER DEFAULT PRIVILEGES IN SCHEMA pos GRANT ALL ON TABLES TO :"pos_user";
    ALTER DEFAULT PRIVILEGES IN SCHEMA pos GRANT ALL ON SEQUENCES TO :"pos_user";
    ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT ALL ON TABLES TO :"pay_user";
    ALTER DEFAULT PRIVILEGES IN SCHEMA payments GRANT ALL ON SEQUENCES TO :"pay_user";
    GRANT ALL ON ALL TABLES IN SCHEMA pos TO :"pos_user";
    GRANT ALL ON ALL SEQUENCES IN SCHEMA pos TO :"pos_user";
    GRANT ALL ON ALL TABLES IN SCHEMA payments TO :"pay_user";
    GRANT ALL ON ALL SEQUENCES IN SCHEMA payments TO :"pay_user";
    SQL
    echo "db bootstrap ok"
  SCRIPT
}

resource "aws_ecs_task_definition" "db_bootstrap" {
  family                   = "${var.name_prefix}-db-bootstrap"
  cpu                      = 256
  memory                   = 512
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]

  execution_role_arn = aws_iam_role.db_migrate_exec.arn
  task_role_arn      = aws_iam_role.db_migrate_exec.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "bootstrap"
      image     = "public.ecr.aws/docker/library/postgres:16-alpine"
      essential = true
      command   = ["sh", "-c", local.db_bootstrap_script]
      secrets = [
        { name = "MASTER_PASSWORD", valueFrom = "${aws_secretsmanager_secret.rds_master.arn}:password::" },
        { name = "MASTER_HOST", valueFrom = "${aws_secretsmanager_secret.rds_master.arn}:host::" },
        { name = "MASTER_PORT", valueFrom = "${aws_secretsmanager_secret.rds_master.arn}:port::" },
        { name = "MASTER_USER", valueFrom = "${aws_secretsmanager_secret.rds_master.arn}:username::" },
        { name = "MASTER_DB", valueFrom = "${aws_secretsmanager_secret.rds_master.arn}:dbname::" },
        { name = "POS_USER", valueFrom = "${aws_secretsmanager_secret.db_pos.arn}:username::" },
        { name = "POS_PASSWORD", valueFrom = "${aws_secretsmanager_secret.db_pos.arn}:password::" },
        { name = "PAY_USER", valueFrom = "${aws_secretsmanager_secret.db_payments.arn}:username::" },
        { name = "PAY_PASSWORD", valueFrom = "${aws_secretsmanager_secret.db_payments.arn}:password::" },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.db_migrate.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "bootstrap"
        }
      }
    },
  ])

  tags = {
    service = "platform"
    role    = "db-bootstrap"
  }
}
