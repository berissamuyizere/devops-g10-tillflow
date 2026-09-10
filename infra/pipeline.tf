# CodePipeline for the web service. POS/Payments/Commission plug in behind
# the same shape at G2. Source is GitHub via a pre-authorized
# CodeStar/CodeConnections connection.
#
# `codeconnections_arn` must be provided (see variables.tf). Terraform
# cannot perform the GitHub App handshake automatically.

# ---------------------------------------------------------------------
# CodeBuild — builds the image, pushes to ECR, produces the imagedefinitions.json
# artifact that CodePipeline hands to the ECS deploy stage.
# ---------------------------------------------------------------------
data "aws_iam_policy_document" "codebuild_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "codebuild" {
  name               = "${var.name_prefix}-codebuild"
  assume_role_policy = data.aws_iam_policy_document.codebuild_trust.json
  tags               = { service = "cicd" }
}

data "aws_iam_policy_document" "codebuild" {
  statement {
    effect    = "Allow"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:${data.aws_partition.current.partition}:logs:${local.region}:${local.account_id}:log-group:/aws/codebuild/${var.name_prefix}-*"]
  }
  statement {
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:GetBucketLocation",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.artifacts.arn,
      "${aws_s3_bucket.artifacts.arn}/*",
    ]
  }
  statement {
    effect = "Allow"
    actions = [
      "ecr:GetAuthorizationToken",
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
      "ecr:BatchGetImage",
      "ecr:DescribeImages",
      "ecr:DescribeImageScanFindings",
    ]
    resources = ["*"]
  }
  statement {
    effect    = "Allow"
    actions   = ["codestar-connections:UseConnection"]
    resources = var.codeconnections_arn == null ? ["*"] : [var.codeconnections_arn]
  }
  statement {
    effect    = "Allow"
    actions   = ["ssm:GetParameters"]
    resources = ["arn:${data.aws_partition.current.partition}:ssm:${local.region}:${local.account_id}:parameter/${var.name_prefix}/*"]
  }
}

resource "aws_iam_role_policy" "codebuild" {
  role   = aws_iam_role.codebuild.name
  policy = data.aws_iam_policy_document.codebuild.json
}

resource "aws_cloudwatch_log_group" "codebuild_web" {
  name              = "/aws/codebuild/${var.name_prefix}-web-build"
  retention_in_days = 30
  tags              = { service = "cicd" }
}

resource "aws_codebuild_project" "web" {
  name         = "${var.name_prefix}-web-build"
  service_role = aws_iam_role.codebuild.arn

  artifacts {
    type = "CODEPIPELINE"
  }

  environment {
    compute_type                = "BUILD_GENERAL1_SMALL"
    image                       = "aws/codebuild/standard:7.0"
    type                        = "LINUX_CONTAINER"
    image_pull_credentials_type = "CODEBUILD"
    privileged_mode             = true # docker builds

    environment_variable {
      name  = "AWS_REGION"
      value = var.region
    }
    environment_variable {
      name  = "AWS_ACCOUNT_ID"
      value = local.account_id
    }
    environment_variable {
      name  = "ECR_REPO"
      value = aws_ecr_repository.service["web"].repository_url
    }
    environment_variable {
      name  = "SERVICE"
      value = "web"
    }
    environment_variable {
      name  = "CONTAINER_NAME"
      value = "app"
    }
  }

  source {
    type      = "CODEPIPELINE"
    buildspec = "services/web/buildspec.yml"
  }

  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.codebuild_web.name
    }
  }

  tags = { service = "cicd" }
}

# ---------------------------------------------------------------------
# CodePipeline — Source (GitHub via CodeConnections) → Build → Deploy (ECS).
# ---------------------------------------------------------------------
data "aws_iam_policy_document" "pipeline_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["codepipeline.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "pipeline" {
  name               = "${var.name_prefix}-pipeline"
  assume_role_policy = data.aws_iam_policy_document.pipeline_trust.json
  tags               = { service = "cicd" }
}

data "aws_iam_policy_document" "pipeline" {
  statement {
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:GetBucketLocation",
      "s3:ListBucket",
      "s3:GetObjectVersion",
    ]
    resources = [
      aws_s3_bucket.artifacts.arn,
      "${aws_s3_bucket.artifacts.arn}/*",
    ]
  }
  statement {
    effect    = "Allow"
    actions   = ["codebuild:StartBuild", "codebuild:BatchGetBuilds"]
    resources = [aws_codebuild_project.web.arn]
  }
  statement {
    effect    = "Allow"
    actions   = ["ecs:DescribeServices", "ecs:DescribeTaskDefinition", "ecs:DescribeTasks", "ecs:ListTasks", "ecs:RegisterTaskDefinition", "ecs:UpdateService"]
    resources = ["*"]
  }
  statement {
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.task["web"].arn, aws_iam_role.task_exec["web"].arn]
    condition {
      test     = "StringEqualsIfExists"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  statement {
    effect    = "Allow"
    actions   = ["codestar-connections:UseConnection"]
    resources = var.codeconnections_arn == null ? ["*"] : [var.codeconnections_arn]
  }
}

resource "aws_iam_role_policy" "pipeline" {
  role   = aws_iam_role.pipeline.name
  policy = data.aws_iam_policy_document.pipeline.json
}

resource "aws_codepipeline" "web" {
  count    = var.codeconnections_arn == null ? 0 : 1
  name     = "${var.name_prefix}-web"
  role_arn = aws_iam_role.pipeline.arn

  artifact_store {
    location = aws_s3_bucket.artifacts.bucket
    type     = "S3"
  }

  stage {
    name = "Source"

    action {
      name             = "Source"
      category         = "Source"
      owner            = "AWS"
      provider         = "CodeStarSourceConnection"
      version          = "1"
      output_artifacts = ["source"]

      configuration = {
        ConnectionArn        = var.codeconnections_arn
        FullRepositoryId     = "${var.github_org}/${var.github_repo}"
        BranchName           = "main"
        DetectChanges        = "true"
        OutputArtifactFormat = "CODE_ZIP"
      }
    }
  }

  stage {
    name = "Build"

    action {
      name             = "BuildImage"
      category         = "Build"
      owner            = "AWS"
      provider         = "CodeBuild"
      version          = "1"
      input_artifacts  = ["source"]
      output_artifacts = ["build"]

      configuration = {
        ProjectName = aws_codebuild_project.web.name
      }
    }
  }

  stage {
    name = "Deploy"

    action {
      name            = "DeployToECS"
      category        = "Deploy"
      owner           = "AWS"
      provider        = "ECS"
      version         = "1"
      input_artifacts = ["build"]

      configuration = {
        ClusterName       = aws_ecs_cluster.app.name
        ServiceName       = aws_ecs_service.web.name
        FileName          = "imagedefinitions.json"
        DeploymentTimeout = "10"
      }
    }
  }

  tags = { service = "cicd" }
}
