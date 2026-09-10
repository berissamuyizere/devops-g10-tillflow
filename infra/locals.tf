locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name
  partition  = data.aws_partition.current.partition

  # First two AZs the region offers, so plans are stable across runs.
  azs = slice(data.aws_availability_zones.available.names, 0, 2)

  # Tag every resource. Overridden per-resource by adding `service = "..."`.
  default_tags = {
    group       = "g10"
    owner       = "yordanos"
    environment = var.environment
    service     = "platform"
    managed-by  = "terraform"
    capstone    = "tillflow"
  }

  # Convenience name-builder. E.g. name("web") -> "devops-g10-web".
  # For globally unique names (S3) append `-${local.account_id}`.
  services = ["web", "pos", "payments", "commission"]
}

# Small helper: given a service, produce its standard resource name.
# Used inline as `"${var.name_prefix}-${service}"`.
