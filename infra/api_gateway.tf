# HTTP API in front of the ALB via VPC Link, per ADR-004.

resource "aws_apigatewayv2_vpc_link" "app" {
  name               = "${var.name_prefix}-api-vpclink"
  security_group_ids = [aws_security_group.vpclink.id]
  subnet_ids         = module.vpc.private_subnets

  # security_group_ids is ForceNew. Rename so create_before_destroy can
  # bring the new link up before the old devops-g10-vpclink is deleted.
  lifecycle {
    create_before_destroy = true
  }

  tags = {
    service = "api-gateway"
  }
}

resource "aws_apigatewayv2_api" "app" {
  name          = "${var.name_prefix}-api"
  protocol_type = "HTTP"
  description   = "TillFlow public HTTP API — routes to internal ALB via VPC Link."

  cors_configuration {
    allow_headers = ["content-type", "authorization", "x-amzn-trace-id", "idempotency-key"]
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_origins = ["*"] # capstone; tighten with tenant domain later
    max_age       = 300
  }

  tags = {
    service = "api-gateway"
  }
}

resource "aws_apigatewayv2_integration" "alb" {
  api_id             = aws_apigatewayv2_api.app.id
  integration_type   = "HTTP_PROXY"
  integration_uri    = aws_lb_listener.http.arn
  integration_method = "ANY"
  connection_type    = "VPC_LINK"
  connection_id      = aws_apigatewayv2_vpc_link.app.id

  # Do not map X-Forwarded-For: API Gateway forbids overwrite/append on
  # that header (BadRequestException: Operations on header x-forwarded-for
  # are restricted). Client IP is already in access logs as
  # $context.identity.sourceIp.
  timeout_milliseconds = 29000
}

resource "aws_apigatewayv2_route" "proxy" {
  api_id    = aws_apigatewayv2_api.app.id
  route_key = "ANY /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.alb.id}"
}

resource "aws_apigatewayv2_route" "root" {
  api_id    = aws_apigatewayv2_api.app.id
  route_key = "ANY /"
  target    = "integrations/${aws_apigatewayv2_integration.alb.id}"
}

resource "aws_cloudwatch_log_group" "apigw" {
  name              = "/${var.name_prefix}/api-gateway"
  retention_in_days = 30
  tags = {
    service = "api-gateway"
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.app.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    detailed_metrics_enabled = true
    throttling_burst_limit   = 200
    throttling_rate_limit    = 100
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigw.arn
    format = jsonencode({
      requestId        = "$context.requestId"
      ip               = "$context.identity.sourceIp"
      requestTime      = "$context.requestTime"
      httpMethod       = "$context.httpMethod"
      routeKey         = "$context.routeKey"
      status           = "$context.status"
      protocol         = "$context.protocol"
      responseLength   = "$context.responseLength"
      integrationError = "$context.integrationErrorMessage"
      requestId2       = "$context.extendedRequestId"
    })
  }

  tags = {
    service = "api-gateway"
  }
}

# ---------------------------------------------------------------------
# WAFv2 regional. Attach to the ALB, not the HTTP API $default stage.
# AssociateWebACL rejects aws_apigatewayv2_stage.arn
# (arn:aws:apigateway:region::/apis/.../stages/$default is not a valid
# WAF resource ARN). ALB is a first-class REGIONAL WAF target and sits
# on the same request path (API GW -> VPC Link -> ALB).
# ---------------------------------------------------------------------
resource "aws_wafv2_web_acl" "app" {
  name        = "${var.name_prefix}-waf"
  description = "TillFlow edge protection."
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "AWS-CommonRuleSet"
    priority = 1

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-waf-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWS-KnownBadInputs"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-waf-known-bad"
      sampled_requests_enabled   = true
    }
  }

  # Capstone: exempt Daraja callback path from the rate rule so a spike
  # of legitimate callbacks doesn't get throttled.
  rule {
    name     = "RateLimitExceptCallback"
    priority = 10

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 200
        aggregate_key_type = "IP"

        scope_down_statement {
          not_statement {
            statement {
              byte_match_statement {
                search_string         = "/payments/callback"
                positional_constraint = "STARTS_WITH"
                field_to_match {
                  uri_path {}
                }
                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-waf-ratelimit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name_prefix}-waf"
    sampled_requests_enabled   = true
  }

  tags = {
    service = "waf"
  }
}

resource "aws_wafv2_web_acl_association" "app" {
  resource_arn = aws_lb.app.arn
  web_acl_arn  = aws_wafv2_web_acl.app.arn
}
