# Internal ALB — only reachable from API Gateway VPC Link.

resource "aws_lb" "app" {
  name               = "${var.name_prefix}-alb"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = module.vpc.private_subnets

  drop_invalid_header_fields = true
  enable_deletion_protection = false # capstone

  access_logs {
    bucket  = aws_s3_bucket.logs.bucket
    prefix  = "alb"
    enabled = true
  }

  tags = {
    service = "alb"
  }

  depends_on = [aws_s3_bucket_policy.logs]
}

resource "aws_lb_target_group" "web" {
  name        = "${var.name_prefix}-web-tg"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = module.vpc.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 10
    timeout             = 3
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = 15

  tags = {
    service = "web"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  # Default: 404. Route rules attach per-service below.
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "not found"
      status_code  = "404"
    }
  }
}

# Path routing for G2. More-specific Payments rules beat POS `/internal/v1/sales*`.
# Web stays the catch-all so `/health` `/ready` `/version` keep working for
# platform smoke; TG health checks hit each task's `/health` directly.

resource "aws_lb_target_group" "pos" {
  name        = "${var.name_prefix}-pos-tg"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = module.vpc.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 10
    timeout             = 3
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = 15

  tags = {
    service = "pos"
  }
}

resource "aws_lb_target_group" "payments" {
  name        = "${var.name_prefix}-payments-tg"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = module.vpc.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 10
    timeout             = 3
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = 15

  tags = {
    service = "payments"
  }
}

resource "aws_lb_listener_rule" "payments_callback" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.payments.arn
  }

  condition {
    path_pattern {
      values = ["/payments/*"]
    }
  }
}

resource "aws_lb_listener_rule" "payments_charges" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 11

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.payments.arn
  }

  condition {
    path_pattern {
      values = ["/internal/v1/charges", "/internal/v1/charges/*"]
    }
  }
}

resource "aws_lb_listener_rule" "payments_payments" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 12

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.payments.arn
  }

  condition {
    path_pattern {
      values = ["/internal/v1/payments", "/internal/v1/payments/*"]
    }
  }
}

resource "aws_lb_listener_rule" "payments_payouts" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 13

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.payments.arn
  }

  condition {
    path_pattern {
      values = ["/internal/v1/payouts", "/internal/v1/payouts/*"]
    }
  }
}

resource "aws_lb_listener_rule" "payments_pos_sync" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 14

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.payments.arn
  }

  condition {
    path_pattern {
      values = ["/internal/v1/pos-sync", "/internal/v1/pos-sync/*"]
    }
  }
}

# Payments owns GET /internal/v1/sales/:id/payment — must beat POS sales rule.
resource "aws_lb_listener_rule" "payments_sale_payment" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 15

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.payments.arn
  }

  condition {
    path_pattern {
      values = ["/internal/v1/sales/*/payment"]
    }
  }
}

resource "aws_lb_listener_rule" "pos_sales" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.pos.arn
  }

  condition {
    path_pattern {
      values = ["/sales", "/sales/*"]
    }
  }
}

resource "aws_lb_listener_rule" "pos_internal_sales" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 21

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.pos.arn
  }

  condition {
    path_pattern {
      values = ["/internal/v1/sales", "/internal/v1/sales/*"]
    }
  }
}

resource "aws_lb_listener_rule" "pos_commission" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 22

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.pos.arn
  }

  condition {
    path_pattern {
      values = ["/internal/v1/commission", "/internal/v1/commission/*"]
    }
  }
}

resource "aws_lb_listener_rule" "web" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }

  condition {
    path_pattern {
      values = ["/*"]
    }
  }
}
