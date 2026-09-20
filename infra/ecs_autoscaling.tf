# Y6 — ECS CPU target tracking at 70% (ADR-005). POS and Payments only.
# desired_count on those services is already ignore_changes so this owns
# the replica count after apply. Min matches the current desired_count (2).

locals {
  cpu_autoscale = {
    pos      = aws_ecs_service.pos.name
    payments = aws_ecs_service.payments.name
  }
}

resource "aws_appautoscaling_target" "cpu" {
  for_each = local.cpu_autoscale

  min_capacity       = 2
  max_capacity       = 4
  resource_id        = "service/${aws_ecs_cluster.app.name}/${each.value}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"

  # Last apply updated ci-deploy and RegisterScalableTarget in the same
  # second; the API still evaluated the old policy (no autoscaling allow).
  depends_on = [time_sleep.ci_iam_propagate]
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each = local.cpu_autoscale

  name               = "${var.name_prefix}-${each.key}-cpu-70"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.cpu[each.key].resource_id
  scalable_dimension = aws_appautoscaling_target.cpu[each.key].scalable_dimension
  service_namespace  = aws_appautoscaling_target.cpu[each.key].service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 70
    scale_in_cooldown  = 60
    scale_out_cooldown = 60
  }
}
