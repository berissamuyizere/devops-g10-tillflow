variable "region" {
  description = "AWS region. Must be eu-central-1 per ADR-001."
  type        = string
  default     = "eu-central-1"

  validation {
    condition     = var.region == "eu-central-1"
    error_message = "Region is pinned to eu-central-1 (ADR-001). Update the ADR before changing this."
  }
}

variable "name_prefix" {
  description = "Group-wide resource name prefix. Do not change (ADR-001)."
  type        = string
  default     = "devops-g10"
}

variable "environment" {
  description = "Deployment environment tag. Capstone uses a single 'prod' environment."
  type        = string
  default     = "prod"
}

variable "github_org" {
  description = "GitHub org / owner for the OIDC trust policy."
  type        = string
  default     = "berissamuyizere"
}

variable "github_repo" {
  description = "GitHub repository name for the OIDC trust policy."
  type        = string
  default     = "devops-g10-tillflow"
}

variable "github_owner_id" {
  description = "Numeric GitHub owner id. Required in OIDC sub after 2026-07-15 immutable claims."
  type        = string
  default     = "139049950"
}

variable "github_repo_id" {
  description = "Numeric GitHub repository id. Required in OIDC sub after 2026-07-15 immutable claims."
  type        = string
  default     = "1363012653"
}

variable "web_image_digest" {
  description = <<-EOT
    Full ECR image reference for the web service, including digest.
    Example: 123456789012.dkr.ecr.eu-central-1.amazonaws.com/devops-g10/web@sha256:...
    Set to null on the first apply; the pipeline updates the ECS task
    definition with the real digest after the first deploy.
  EOT
  type        = string
  default     = null
}

variable "pos_image_digest" {
  description = "Full ECR image reference for POS including digest. Null = busybox /health placeholder."
  type        = string
  default     = null
}

variable "payments_image_digest" {
  description = "Full ECR image reference for Payments including digest. Null = busybox /health placeholder."
  type        = string
  default     = null
}

variable "commission_image_digest" {
  description = "Full ECR image reference for Commission including digest. Null = busybox /health placeholder."
  type        = string
  default     = null
}

variable "adot_collector_image" {
  description = "Pinned ADOT collector image (never `latest`)."
  type        = string
  default     = "public.ecr.aws/aws-observability/aws-otel-collector:v0.43.1"
}

variable "codeconnections_arn" {
  description = <<-EOT
    ARN of a pre-created AWS CodeStar / CodeConnections connection to GitHub.
    Create once in the console (Developer Tools → Settings → Connections),
    authorize the GitHub App, then paste the ARN here.
    Terraform cannot create the GitHub App handshake for you.
  EOT
  type        = string
  default     = null
}

variable "waf_rate_limit" {
  description = <<-EOT
    WAF RateLimitExceptCallback: requests per 5 minutes per IP (not the
    callback path). Default 200 (~0.66 rps) is the G3/G5 envelope.
    Raise via GitHub variable WAF_RATE_LIMIT (Release sets
    TF_VAR_waf_rate_limit) for Saloi's k6 soak, then set it back to 200
    and workflow_dispatch Release. Do not leave a high limit overnight.
  EOT
  type        = number
  default     = 200

  validation {
    condition     = var.waf_rate_limit >= 100
    error_message = "AWS WAF rate-based limits must be at least 100."
  }
}
