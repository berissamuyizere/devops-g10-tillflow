# The backend is intentionally partial: `bucket`, `dynamodb_table`, `region`,
# and `key` are provided by `terraform init -backend-config=...`.
# See infra/bootstrap/README.md for the exact one-time init command.

terraform {
  backend "s3" {
    encrypt = true
  }
}
