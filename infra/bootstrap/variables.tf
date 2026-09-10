variable "region" {
  description = "AWS region for the state bucket + lock table. Must match the root module."
  type        = string
  default     = "eu-central-1"
}

variable "name_prefix" {
  description = "Group-wide resource name prefix. Do not change."
  type        = string
  default     = "devops-g10"
}
