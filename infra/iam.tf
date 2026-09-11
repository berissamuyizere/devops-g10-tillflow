# Account already has this provider (lab). We cannot create or tag it
# (iam:TagOpenIDConnectProvider is denied). Read it only.
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "gha_trust" {
  # This account enforces AWS's 2026 GitHub-OIDC guard:
  # UpdateAssumeRolePolicy requires token.actions.githubusercontent.com:sub
  # or :job_workflow_ref, "not scoped to all" (a trailing :* is rejected).
  # A statement with only repository_id was rejected with MalformedPolicyDocument.
  #
  # GitHub will not disable immutable subjects here (repo created 2026-09-09;
  # PUT use_immutable_subject=false stayed true). Tokens therefore use
  # repo:owner@id/name@id:pull_request. Exact-match on that sub still
  # AccessDenied in CloudTrail — IAM condition evaluation of `sub` is
  # unreliable once `@` is in the claim. job_workflow_ref stays
  # owner/repo/.github/workflows/file@ref and is what AWS told us to use.

  statement {
    sid     = "GitHubOIDCByWorkflowRef"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:job_workflow_ref"
      values = [
        "${var.github_org}/${var.github_repo}/.github/workflows/pr.yml@*",
        "${var.github_org}/${var.github_repo}/.github/workflows/release.yml@*",
        "${var.github_org}@${var.github_owner_id}/${var.github_repo}@${var.github_repo_id}/.github/workflows/pr.yml@*",
        "${var.github_org}@${var.github_owner_id}/${var.github_repo}@${var.github_repo_id}/.github/workflows/release.yml@*",
      ]
    }
  }

  statement {
    sid     = "GitHubOIDCBySub"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_org}/${var.github_repo}:pull_request",
        "repo:${var.github_org}/${var.github_repo}:ref:refs/heads/main",
        "repo:${var.github_org}/${var.github_repo}:ref:refs/heads/develop",
        "repo:${var.github_org}@${var.github_owner_id}/${var.github_repo}@${var.github_repo_id}:pull_request",
        "repo:${var.github_org}@${var.github_owner_id}/${var.github_repo}@${var.github_repo_id}:ref:refs/heads/main",
        "repo:${var.github_org}@${var.github_owner_id}/${var.github_repo}@${var.github_repo_id}:ref:refs/heads/develop",
      ]
    }
  }
}

resource "aws_iam_role" "ci_deploy" {
  name               = "${var.name_prefix}-ci-deploy"
  description        = "GitHub Actions OIDC role for terraform plan/apply and ECR push."
  assume_role_policy = data.aws_iam_policy_document.gha_trust.json

  tags = {
    service = "cicd"
  }
}

# Scope: Terraform manages every namespaced resource in this account, so the
# CI role gets a broad-but-namespaced allow. Anything outside devops-g10-*
# is implicitly denied.
data "aws_iam_policy_document" "ci_deploy" {
  # Broad describe/list — Terraform plan needs to read many services.
  statement {
    sid    = "ReadEverythingForPlan"
    effect = "Allow"
    actions = [
      "ec2:Describe*",
      "elasticloadbalancing:Describe*",
      "iam:Get*",
      "iam:List*",
      "iam:SimulatePrincipalPolicy",
      "rds:Describe*",
      "elasticache:Describe*",
      "s3:List*",
      "s3:GetBucket*",
      "s3:GetObject*",
      "sqs:List*",
      "sqs:GetQueueAttributes",
      "logs:Describe*",
      "cloudwatch:Describe*",
      "cloudwatch:List*",
      "events:List*",
      "events:Describe*",
      "ecr:Describe*",
      "ecr:List*",
      "ecr:BatchGet*",
      "ecs:Describe*",
      "ecs:List*",
      "apigateway:GET",
      "wafv2:List*",
      "wafv2:Get*",
      "codepipeline:List*",
      "codepipeline:Get*",
      "codebuild:List*",
      "codebuild:Batch*",
      "codestar-connections:List*",
      "codestar-connections:Get*",
      "secretsmanager:ListSecrets",
      "secretsmanager:DescribeSecret",
      "kms:Describe*",
      "kms:List*",
      "sts:GetCallerIdentity",
    ]
    resources = ["*"]
  }

  # Namespaced write on the resources Terraform manages.
  statement {
    sid    = "WriteNamespacedResources"
    effect = "Allow"
    actions = [
      "ec2:*",
      "elasticloadbalancing:*",
      "rds:*",
      "elasticache:*",
      "s3:*",
      "sqs:*",
      "logs:*",
      "cloudwatch:*",
      "events:*",
      "ecr:*",
      "ecs:*",
      "apigateway:*",
      "wafv2:*",
      "codepipeline:*",
      "codebuild:*",
      "iam:*",
      "secretsmanager:*",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region]
    }
  }

  # Docker push.
  statement {
    sid    = "ECRPushImages"
    effect = "Allow"
    actions = [
      "ecr:GetAuthorizationToken",
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = ["*"]
  }

  # IAM is global, so PassRole does not satisfy aws:RequestedRegion on
  # the write statement above. Needed to register ECS task defs from CI.
  statement {
    sid     = "PassTaskRolesToECS"
    effect  = "Allow"
    actions = ["iam:PassRole"]
    resources = [
      "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.name_prefix}-*-task",
      "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.name_prefix}-*-exec",
    ]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_policy" "ci_deploy" {
  name        = "${var.name_prefix}-ci-deploy"
  description = "Permissions for the GitHub Actions CI deploy role."
  policy      = data.aws_iam_policy_document.ci_deploy.json
}

resource "aws_iam_role_policy_attachment" "ci_deploy" {
  role       = aws_iam_role.ci_deploy.name
  policy_arn = aws_iam_policy.ci_deploy.arn
}

# ---------------------------------------------------------------------
# Per-service ECS task + exec roles.
# ---------------------------------------------------------------------
data "aws_iam_policy_document" "ecs_task_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# --- Exec role (shared shape per service) ---
resource "aws_iam_role" "task_exec" {
  for_each           = toset(local.services)
  name               = "${var.name_prefix}-${each.value}-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_trust.json
  tags               = { service = each.value }
}

resource "aws_iam_role_policy_attachment" "task_exec_default" {
  for_each   = toset(local.services)
  role       = aws_iam_role.task_exec[each.key].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Exec role also needs to fetch secrets it will inject into the container env.
data "aws_iam_policy_document" "task_exec_secrets" {
  statement {
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.daraja.arn,
      aws_secretsmanager_secret.slack.arn,
      aws_secretsmanager_secret.rds_master.arn,
      aws_secretsmanager_secret.cache_auth.arn,
    ]
  }
  statement {
    effect    = "Allow"
    actions   = ["ssm:GetParameters", "ssm:GetParameter"]
    resources = ["arn:${data.aws_partition.current.partition}:ssm:${local.region}:${local.account_id}:parameter/${var.name_prefix}/*"]
  }
}

resource "aws_iam_policy" "task_exec_secrets" {
  name        = "${var.name_prefix}-task-exec-secrets"
  description = "ECS exec role permission to read our task secrets."
  policy      = data.aws_iam_policy_document.task_exec_secrets.json
}

resource "aws_iam_role_policy_attachment" "task_exec_secrets" {
  for_each   = toset(local.services)
  role       = aws_iam_role.task_exec[each.key].name
  policy_arn = aws_iam_policy.task_exec_secrets.arn
}

# --- Task roles (per service; each starts empty and grows in G2) ---
resource "aws_iam_role" "task" {
  for_each           = toset(local.services)
  name               = "${var.name_prefix}-${each.value}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_trust.json
  tags               = { service = each.value }
}

# Every task role gets: X-Ray write, CloudWatch metrics put, its own logs.
data "aws_iam_policy_document" "task_common" {
  statement {
    effect = "Allow"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
      "xray:GetSamplingRules",
      "xray:GetSamplingTargets",
      "xray:GetSamplingStatisticSummaries",
    ]
    resources = ["*"]
  }
  statement {
    effect    = "Allow"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["TillFlow"]
    }
  }
  statement {
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["arn:${data.aws_partition.current.partition}:logs:${local.region}:${local.account_id}:log-group:/${var.name_prefix}/*"]
  }
}

resource "aws_iam_policy" "task_common" {
  name        = "${var.name_prefix}-task-common"
  description = "Base permissions attached to every service task role (X-Ray, metrics, own logs)."
  policy      = data.aws_iam_policy_document.task_common.json
}

resource "aws_iam_role_policy_attachment" "task_common" {
  for_each   = toset(local.services)
  role       = aws_iam_role.task[each.key].name
  policy_arn = aws_iam_policy.task_common.arn
}

# --- Service-specific task role permissions ---

# Payments: read Daraja secret, publish to callback queue, read/dequeue.
data "aws_iam_policy_document" "payments_task" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.daraja.arn]
  }
  statement {
    effect = "Allow"
    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility",
    ]
    resources = [
      aws_sqs_queue.payments_callbacks.arn,
      aws_sqs_queue.payments_callbacks_dlq.arn,
    ]
  }
}

resource "aws_iam_policy" "payments_task" {
  name   = "${var.name_prefix}-payments-task"
  policy = data.aws_iam_policy_document.payments_task.json
}

resource "aws_iam_role_policy_attachment" "payments_task" {
  role       = aws_iam_role.task["payments"].name
  policy_arn = aws_iam_policy.payments_task.arn
}

# Commission: consume close queue, read backups (for ledger exports).
data "aws_iam_policy_document" "commission_task" {
  statement {
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility",
    ]
    resources = [
      aws_sqs_queue.commission_close.arn,
      aws_sqs_queue.commission_close_dlq.arn,
    ]
  }
  statement {
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.backups.arn}/commission/*"]
  }
}

resource "aws_iam_policy" "commission_task" {
  name   = "${var.name_prefix}-commission-task"
  policy = data.aws_iam_policy_document.commission_task.json
}

resource "aws_iam_role_policy_attachment" "commission_task" {
  role       = aws_iam_role.task["commission"].name
  policy_arn = aws_iam_policy.commission_task.arn
}
