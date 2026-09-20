# Placeholders for secrets that other DRIs will populate.
# We create the secret entries so IAM policies can reference them by ARN and
# services can be deployed; the actual values are set out-of-band (never in
# Git, never in Terraform state).

# ---------------------------------------------------------------------
# Daraja sandbox credentials — Arsema populates via `aws secretsmanager
# put-secret-value` after G1 apply.
# ---------------------------------------------------------------------
resource "aws_secretsmanager_secret" "daraja" {
  name                    = "${var.name_prefix}/daraja"
  description             = "Daraja 3.0 SANDBOX credentials (consumer key/secret, shortcode, passkey). SANDBOX ONLY."
  recovery_window_in_days = 0 # G5 rebuild: a 7–30d window blocks recreate of the same name

  tags = {
    service      = "payments"
    populated-by = "arsema"
  }
}

resource "aws_secretsmanager_secret_version" "daraja_placeholder" {
  secret_id = aws_secretsmanager_secret.daraja.id
  secret_string = jsonencode({
    consumer_key    = "PLACEHOLDER"
    consumer_secret = "PLACEHOLDER"
    shortcode       = "PLACEHOLDER"
    passkey         = "PLACEHOLDER"
    environment     = "sandbox"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ---------------------------------------------------------------------
# Slack webhook — Saloi populates. Same pattern.
# ---------------------------------------------------------------------
resource "aws_secretsmanager_secret" "slack" {
  name                    = "${var.name_prefix}/slack-webhook"
  description             = "Slack incoming-webhook URL for alerts."
  recovery_window_in_days = 0 # G5 rebuild: same name must be free immediately

  tags = {
    service      = "reliability"
    populated-by = "saloi"
  }
}

resource "aws_secretsmanager_secret_version" "slack_placeholder" {
  secret_id     = aws_secretsmanager_secret.slack.id
  secret_string = jsonencode({ url = "PLACEHOLDER" })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ---------------------------------------------------------------------
# G2 service-to-service tokens + callback HMAC.
# Generated once; ignore_changes so a later apply never rotates them under
# a running stack. Rotate out-of-band with put-secret-value if needed.
# ---------------------------------------------------------------------
resource "random_password" "payments_service_token" {
  length  = 48
  special = false
}

resource "random_password" "pos_service_token" {
  length  = 48
  special = false
}

resource "random_password" "commission_service_token" {
  length  = 48
  special = false
}

resource "random_password" "daraja_callback_secret" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "service_tokens" {
  name                    = "${var.name_prefix}/service-tokens"
  description             = "POS ↔ Payments ↔ Commission shared tokens + Daraja callback HMAC (G2)."
  recovery_window_in_days = 0 # G5 rebuild: same name must be free immediately

  tags = {
    service = "platform"
  }
}

resource "aws_secretsmanager_secret_version" "service_tokens" {
  secret_id = aws_secretsmanager_secret.service_tokens.id
  secret_string = jsonencode({
    payments_service_token   = random_password.payments_service_token.result
    pos_service_token        = random_password.pos_service_token.result
    commission_service_token = random_password.commission_service_token.result
    daraja_callback_secret   = random_password.daraja_callback_secret.result
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ---------------------------------------------------------------------
# Per-service DB role credentials (ADR-003). Roles/schemas are created by
# the one-off migrate task; these secrets are what the ECS tasks read.
# ---------------------------------------------------------------------
resource "random_password" "db_pos" {
  length           = 32
  special          = true
  override_special = "!#$%^&*()-_=+[]{}<>?"
}

resource "random_password" "db_payments" {
  length           = 32
  special          = true
  override_special = "!#$%^&*()-_=+[]{}<>?"
}

resource "aws_secretsmanager_secret" "db_pos" {
  name                    = "${var.name_prefix}/db/pos"
  description             = "RDS credentials for the devops_g10_pos role (schema pos)."
  recovery_window_in_days = 0 # G5 rebuild: same name must be free immediately

  tags = {
    service = "pos"
  }
}

resource "aws_secretsmanager_secret_version" "db_pos" {
  secret_id = aws_secretsmanager_secret.db_pos.id
  secret_string = jsonencode({
    username = "devops_g10_pos"
    password = random_password.db_pos.result
    engine   = "postgres"
    host     = aws_db_instance.pg.address
    port     = 5432
    dbname   = "tillflow"
    schema   = "pos"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "db_payments" {
  name                    = "${var.name_prefix}/db/payments"
  description             = "RDS credentials for the devops_g10_payments role (schema payments)."
  recovery_window_in_days = 0 # G5 rebuild: same name must be free immediately

  tags = {
    service = "payments"
  }
}

resource "aws_secretsmanager_secret_version" "db_payments" {
  secret_id = aws_secretsmanager_secret.db_payments.id
  secret_string = jsonencode({
    username = "devops_g10_payments"
    password = random_password.db_payments.result
    engine   = "postgres"
    host     = aws_db_instance.pg.address
    port     = 5432
    dbname   = "tillflow"
    schema   = "payments"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}
