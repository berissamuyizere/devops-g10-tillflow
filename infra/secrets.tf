# Placeholders for secrets that other DRIs will populate.
# We create the secret entries so IAM policies can reference them by ARN and
# services can be deployed; the actual values are set out-of-band (never in
# Git, never in Terraform state).

# ---------------------------------------------------------------------
# Daraja sandbox credentials — Arsema populates via `aws secretsmanager
# put-secret-value` after G1 apply.
# ---------------------------------------------------------------------
resource "aws_secretsmanager_secret" "daraja" {
  name        = "${var.name_prefix}/daraja"
  description = "Daraja 3.0 SANDBOX credentials (consumer key/secret, shortcode, passkey). SANDBOX ONLY."

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
  name        = "${var.name_prefix}/slack-webhook"
  description = "Slack incoming-webhook URL for alerts."

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
