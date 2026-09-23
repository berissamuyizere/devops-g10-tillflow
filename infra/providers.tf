provider "aws" {
  region = var.region

  default_tags {
    tags = local.default_tags
  }
}

# Grafana HTTP provider is unused. AMG is DELETION_FAILED (G5 SSO deny);
# dashboards live on Grafana Cloud. JSON files stay under infra/grafana/.
