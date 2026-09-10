# ElastiCache Valkey per ADR-003.

resource "aws_elasticache_subnet_group" "cache" {
  name       = "${var.name_prefix}-cache"
  subnet_ids = module.vpc.private_subnets

  tags = {
    service = "cache"
  }
}

resource "random_password" "cache_auth" {
  length  = 32
  special = false # Valkey AUTH does not allow all specials
}

resource "aws_secretsmanager_secret" "cache_auth" {
  name        = "${var.name_prefix}/cache/auth"
  description = "Valkey AUTH token."

  tags = {
    service = "cache"
  }
}

resource "aws_secretsmanager_secret_version" "cache_auth" {
  secret_id = aws_secretsmanager_secret.cache_auth.id
  secret_string = jsonencode({
    auth_token = random_password.cache_auth.result
    host       = aws_elasticache_replication_group.valkey.primary_endpoint_address
    port       = 6379
  })
}

resource "aws_elasticache_replication_group" "valkey" {
  replication_group_id = "${var.name_prefix}-valkey"
  description          = "TillFlow cache-aside Valkey."
  engine               = "valkey"
  engine_version       = "7.2"
  node_type            = "cache.t4g.micro"
  num_cache_clusters   = 1
  parameter_group_name = "default.valkey7"
  port                 = 6379

  automatic_failover_enabled = false
  multi_az_enabled           = false

  subnet_group_name  = aws_elasticache_subnet_group.cache.name
  security_group_ids = [aws_security_group.cache.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.cache_auth.result

  snapshot_retention_limit = 3
  snapshot_window          = "03:00-04:00"

  apply_immediately = false

  tags = {
    service = "cache"
  }
}
