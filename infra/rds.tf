# RDS PostgreSQL per ADR-003. Single-AZ for capstone cost; documented risk.

resource "random_password" "rds_master" {
  length           = 32
  special          = true
  override_special = "!#$%^&*()-_=+[]{}<>?"
}

resource "aws_secretsmanager_secret" "rds_master" {
  name        = "${var.name_prefix}/db/master"
  description = "RDS master credentials for TillFlow — used only for schema bootstrap."
  # KMS: AWS-managed default.

  tags = {
    service = "rds"
  }
}

resource "aws_secretsmanager_secret_version" "rds_master" {
  secret_id = aws_secretsmanager_secret.rds_master.id
  secret_string = jsonencode({
    username = "tillflow_master"
    password = random_password.rds_master.result
    engine   = "postgres"
    port     = 5432
    dbname   = "tillflow"
    host     = aws_db_instance.pg.address
  })
}

resource "aws_db_parameter_group" "pg16" {
  name        = "${var.name_prefix}-pg16"
  family      = "postgres16"
  description = "TillFlow RDS Postgres 16 parameters"

  parameter {
    name  = "log_min_duration_statement"
    value = "500" # log slow queries > 500ms
  }

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  tags = {
    service = "rds"
  }
}

resource "aws_db_instance" "pg" {
  identifier     = "${var.name_prefix}-pg"
  engine         = "postgres"
  engine_version = "16.15"
  instance_class = "db.t4g.micro"

  db_name  = "tillflow"
  username = "tillflow_master"
  password = random_password.rds_master.result
  port     = 5432

  allocated_storage     = 20
  max_allocated_storage = 50
  storage_type          = "gp3"
  storage_encrypted     = true

  multi_az = false # ADR-003: single-AZ for capstone cost

  db_subnet_group_name   = module.vpc.database_subnet_group_name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false

  backup_retention_period  = 7
  backup_window            = "02:00-03:00" # UTC ~ 05:00-06:00 EAT
  maintenance_window       = "sun:03:30-sun:05:00"
  delete_automated_backups = false
  copy_tags_to_snapshot    = true

  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name_prefix}-pg-final-${formatdate("YYYYMMDDhhmm", timestamp())}"

  performance_insights_enabled          = true
  performance_insights_retention_period = 7 # free tier
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]

  parameter_group_name       = aws_db_parameter_group.pg16.name
  auto_minor_version_upgrade = true

  lifecycle {
    ignore_changes = [final_snapshot_identifier]
  }

  tags = {
    service = "rds"
  }
}
