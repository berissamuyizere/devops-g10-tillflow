output "state_bucket" {
  description = "Name of the S3 bucket that stores Terraform state for the root module."
  value       = aws_s3_bucket.tfstate.bucket
}

output "lock_table" {
  description = "Name of the DynamoDB table used for Terraform state locking."
  value       = aws_dynamodb_table.tflock.name
}

output "region" {
  description = "AWS region the bootstrap resources live in."
  value       = var.region
}
