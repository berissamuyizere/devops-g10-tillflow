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
      "application-autoscaling:Describe*",
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
      "ssm:Get*",
      "ssm:Describe*",
      "ssm:List*",
      "sts:GetCallerIdentity",
      "grafana:Describe*",
      "grafana:List*",
      "synthetics:Describe*",
      "synthetics:Get*",
      "synthetics:List*",
      "lambda:Get*",
      "lambda:List*",
      "sns:Get*",
      "sns:List*",
    ]
    resources = ["*"]
  }

  # State lock lives in bootstrap (not this stack). Plan and apply both
  # PutItem/GetItem/DeleteItem on devops-g10-tflock. Without this, OIDC
  # succeeds and terraform plan fails with AccessDenied on DynamoDB.
  statement {
    sid    = "TerraformStateLock"
    effect = "Allow"
    actions = [
      "dynamodb:DescribeTable",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:dynamodb:${var.region}:${data.aws_caller_identity.current.account_id}:table/${var.name_prefix}-tflock",
    ]
  }

  # Regional data-plane writes. EC2/ELB/RDS/API Gateway do not take a
  # stable devops-g10-* ARN on Create*, so these stay region-locked.
  # IAM / S3 / Secrets / SSM are scoped to the prefix in the statements
  # below — do not put iam:* here (privilege escalation).
  statement {
    sid    = "WriteNamespacedResources"
    effect = "Allow"
    actions = [
      "ec2:*",
      "elasticloadbalancing:*",
      "rds:*",
      "elasticache:*",
      "sqs:*",
      "logs:*",
      "cloudwatch:*",
      "events:*",
      "ecr:*",
      "ecs:*",
      "application-autoscaling:*",
      "apigateway:*",
      "wafv2:*",
      "codepipeline:*",
      "codebuild:*",
      "grafana:*",
      "synthetics:*",
      "lambda:*",
      "sns:*",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region]
    }
  }

  statement {
    sid    = "WriteNamespacedIAM"
    effect = "Allow"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRoleDescription",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:CreatePolicy",
      "iam:DeletePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy",
      "iam:UntagPolicy",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.name_prefix}-*",
      "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:policy/${var.name_prefix}-*",
    ]
  }

  statement {
    sid    = "CreateAllowedServiceLinkedRoles"
    effect = "Allow"
    actions = [
      "iam:CreateServiceLinkedRole",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/aws-service-role/*",
    ]
    condition {
      test     = "StringEquals"
      variable = "iam:AWSServiceName"
      values = [
        "inspector2.amazonaws.com",
        "rds.amazonaws.com",
        "elasticache.amazonaws.com",
        "elasticloadbalancing.amazonaws.com",
        "grafana.amazonaws.com",
        "ecs.application-autoscaling.amazonaws.com",
        "synthetics.amazonaws.com",
        "sso.amazonaws.com",
        "organizations.amazonaws.com",
      ]
    }
  }

  statement {
    sid    = "WriteNamespacedS3"
    effect = "Allow"
    actions = [
      "s3:*",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:s3:::${var.name_prefix}-*",
      "arn:${data.aws_partition.current.partition}:s3:::${var.name_prefix}-*/*",
    ]
  }

  statement {
    sid    = "WriteNamespacedSecretsAndSSM"
    effect = "Allow"
    actions = [
      "secretsmanager:*",
      "ssm:*",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:${var.name_prefix}/*",
      "arn:${data.aws_partition.current.partition}:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/${var.name_prefix}/*",
    ]
  }

  # CreateKey has no namespaced ARN. Tag the key group=g10 (default_tags)
  # so this cannot mint keys for other work in the account. TagResource
  # must be on * here: during CreateKey the key ARN does not exist yet,
  # so ManageNamespacedKMS (key/*) never matches.
  statement {
    sid    = "CreateNamespacedKMSKeys"
    effect = "Allow"
    actions = [
      "kms:CreateKey",
      "kms:TagResource",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = [var.region]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/group"
      values   = ["g10"]
    }
  }

  # TagResource on Create* is authorized against a parent ARN (Grafana
  # /workspaces) or * (KMS). Several of these APIs omit
  # aws:RequestedRegion, so they miss the regional grafana:* / lambda:*
  # write statement. Bound by default_tags group=g10.
  statement {
    sid    = "TagOnCreateWithoutRegionContext"
    effect = "Allow"
    actions = [
      "kms:TagResource",
      "lambda:TagResource",
      "sns:TagResource",
      "synthetics:TagResource",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/group"
      values   = ["g10"]
    }
  }

  # Grafana + IAM Identity Center + SSO KMS decrypt are NOT in this
  # document. Customer managed policies cap at 6144 bytes; stuffing SSO
  # statements here failed CreatePolicyVersion. Those permissions live on
  # AWS managed policies attached to this role:
  # AWSGrafanaAccountAdministrator, AWSSSOMasterAccountAdministrator,
  # AWSSSODirectoryAdministrator.

  statement {
    sid    = "ManageNamespacedKMS"
    effect = "Allow"
    actions = [
      "kms:CreateAlias",
      "kms:DeleteAlias",
      "kms:UpdateAlias",
      "kms:DescribeKey",
      "kms:GetKeyPolicy",
      "kms:PutKeyPolicy",
      "kms:ScheduleKeyDeletion",
      "kms:CancelKeyDeletion",
      "kms:EnableKeyRotation",
      "kms:GetKeyRotationStatus",
      "kms:Decrypt",
      "kms:Encrypt",
      "kms:GenerateDataKey*",
      "kms:CreateGrant",
      "kms:ListGrants",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:ListResourceTags",
      "kms:UpdateKeyDescription",
      "kms:EnableKey",
      "kms:DisableKey",
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:kms:${var.region}:${data.aws_caller_identity.current.account_id}:key/*",
      "arn:${data.aws_partition.current.partition}:kms:${var.region}:${data.aws_caller_identity.current.account_id}:alias/${var.name_prefix}-*",
    ]
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

  statement {
    sid     = "PassRolesToGrafanaLambdaSynthetics"
    effect  = "Allow"
    actions = ["iam:PassRole"]
    resources = [
      "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.name_prefix}-grafana",
      "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.name_prefix}-probe",
      "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.name_prefix}-slack-notifier",
      "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/${var.name_prefix}-payout-cutoff",
    ]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values = [
        "grafana.amazonaws.com",
        "lambda.amazonaws.com",
        "synthetics.amazonaws.com",
      ]
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

# AWS's documented set for creating Amazon Managed Grafana with IAM
# Identity Center in a standalone account. AWSSSOMasterAccountAdministrator
# is the policy that actually allows kms:Decrypt via sso.*.amazonaws.com.
resource "aws_iam_role_policy_attachment" "ci_grafana_account" {
  role       = aws_iam_role.ci_deploy.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AWSGrafanaAccountAdministrator"
}

resource "aws_iam_role_policy_attachment" "ci_sso_master" {
  role       = aws_iam_role.ci_deploy.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AWSSSOMasterAccountAdministrator"
}

resource "aws_iam_role_policy_attachment" "ci_sso_directory" {
  role       = aws_iam_role.ci_deploy.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AWSSSODirectoryAdministrator"
}

# IAM and Identity Center are eventual-consistent across regions. The last
# Release updated ci-deploy then CreateWorkspace in the same second; SSO
# in us-east-1 still evaluated the old policy.
resource "time_sleep" "ci_iam_propagate" {
  create_duration = "45s"
  triggers = {
    ci_policy     = aws_iam_policy.ci_deploy.policy
    grafana_admin = aws_iam_role_policy_attachment.ci_grafana_account.id
    sso_master    = aws_iam_role_policy_attachment.ci_sso_master.id
    sso_directory = aws_iam_role_policy_attachment.ci_sso_directory.id
  }
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
      aws_secretsmanager_secret.service_tokens.arn,
      aws_secretsmanager_secret.db_pos.arn,
      aws_secretsmanager_secret.db_payments.arn,
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

# POS: read its DB secret (app resolves DB_SECRET_ID at boot).
data "aws_iam_policy_document" "pos_task" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.db_pos.arn]
  }
}

resource "aws_iam_policy" "pos_task" {
  name   = "${var.name_prefix}-pos-task"
  policy = data.aws_iam_policy_document.pos_task.json
}

resource "aws_iam_role_policy_attachment" "pos_task" {
  role       = aws_iam_role.task["pos"].name
  policy_arn = aws_iam_policy.pos_task.arn
}

# Payments: Daraja secret, DB secret, callback queue.
data "aws_iam_policy_document" "payments_task" {
  statement {
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.daraja.arn,
      aws_secretsmanager_secret.db_payments.arn,
    ]
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
