provider "aws" {
  region = var.region

  default_tags {
    tags = local.default_tags
  }
}

# Dashboards are Grafana HTTP API objects. Auth is a workspace service-account
# token Terraform creates; it is not IAM Identity Center and is not the Slack
# webhook. First apply creates the workspace, then this provider, then JSON.
provider "grafana" {
  url  = "https://${aws_grafana_workspace.amg.endpoint}"
  auth = aws_grafana_workspace_service_account_token.terraform.key
}
