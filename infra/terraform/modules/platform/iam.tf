# Least privilege (access control policy): the execution role starts tasks (pull images, read
# their secrets, write logs); each task role has only what that code calls at run time.

locals {
  ecs_tasks_assume = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = local.account_id }
        ArnLike      = { "aws:SourceArn" = "arn:${local.partition}:ecs:${local.region}:${local.account_id}:*" }
      }
    }]
  })
}

resource "aws_iam_role" "execution" {
  name               = "${local.prefix}-ecs-execution"
  assume_role_policy = local.ecs_tasks_assume
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "read-task-secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = "arn:${local.partition}:secretsmanager:${local.region}:${local.account_id}:secret:${local.secret_prefix}/*"
      },
      {
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = [aws_kms_key.storage.arn]
        Condition = {
          StringEquals = { "kms:ViaService" = "secretsmanager.${local.region}.amazonaws.com" }
        }
      },
    ]
  })
}

locals {
  # Unwrapping the field data keys at start-up (ADR 0029): Decrypt, with our encryption context.
  field_key_decrypt = {
    Effect   = "Allow"
    Action   = "kms:Decrypt"
    Resource = aws_kms_key.field.arn
    Condition = {
      StringEquals = {
        "kms:EncryptionContext:app"     = "acct"
        "kms:EncryptionContext:purpose" = "field-key"
      }
    }
  }
  documents_access = [
    {
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
      Resource = "${aws_s3_bucket.documents.arn}/*"
    },
    {
      Effect   = "Allow"
      Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
      Resource = aws_kms_key.storage.arn
      Condition = {
        StringEquals = { "kms:ViaService" = "s3.${local.region}.amazonaws.com" }
      }
    },
  ]
  send_mail = {
    Effect   = "Allow"
    Action   = ["ses:SendEmail", "ses:SendRawEmail"]
    Resource = [aws_sesv2_email_identity.mail.arn, aws_sesv2_configuration_set.main.arn]
  }
}

# API and worker: documents, field keys (decrypt only), mail.
resource "aws_iam_role" "app" {
  name               = "${local.prefix}-app"
  assume_role_policy = local.ecs_tasks_assume
  tags               = local.tags
}

resource "aws_iam_role_policy" "app" {
  name = "app"
  role = aws_iam_role.app.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = concat([local.field_key_decrypt, local.send_mail], local.documents_access)
  })
}

# ECS Exec for break-glass access to a running task (logged by CloudTrail, access policy).
resource "aws_iam_role_policy" "app_exec" {
  name = "ecs-exec"
  role = aws_iam_role.app.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"]
      Resource = "*"
    }]
  })
}

# The release step and the keys:* commands (run with the release task definition): field keys
# may be generated and wrapped here, never by the API or worker.
resource "aws_iam_role" "release" {
  name               = "${local.prefix}-release"
  assume_role_policy = local.ecs_tasks_assume
  tags               = local.tags
}

resource "aws_iam_role_policy" "release" {
  name = "release"
  role = aws_iam_role.release.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
      Resource = aws_kms_key.field.arn
      Condition = {
        StringEquals = {
          "kms:EncryptionContext:app"     = "acct"
          "kms:EncryptionContext:purpose" = "field-key"
        }
      }
    }]
  })
}

# The web tasks call nothing in AWS.
resource "aws_iam_role" "web" {
  name               = "${local.prefix}-web"
  assume_role_policy = local.ecs_tasks_assume
  tags               = local.tags
}

# --- GitHub Actions (deploy workflow, ADR 0030) ------------------------------------------------------

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_github_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  tags           = local.tags
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  github_oidc_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
}

# Only jobs of this repository's deploy workflow running in the GitHub environment named like
# this one (which has required reviewers for production) can take this role.
resource "aws_iam_role" "deploy" {
  name = "${local.prefix}-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.github_oidc_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:environment:${var.environment}"
        }
      }
    }]
  })
  max_session_duration = 3600
  tags                 = local.tags
}

resource "aws_iam_role_policy" "deploy" {
  name = "deploy"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrLogin"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "PushImages"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload",
          "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload",
          "ecr:PutImage", "ecr:UploadLayerPart",
        ]
        Resource = [for r in aws_ecr_repository.app : r.arn]
      },
      {
        Sid      = "PullTestedImages"
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability", "ecr:DescribeImages"]
        Resource = var.image_source_account_id == null ? [for r in aws_ecr_repository.app : r.arn] : ["arn:${local.partition}:ecr:${local.region}:${var.image_source_account_id}:repository/${var.name}/*"]
      },
      {
        Sid      = "EncryptImages"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.storage.arn
        Condition = {
          StringEquals = { "kms:ViaService" = "ecr.${local.region}.amazonaws.com" }
        }
      },
      {
        Sid      = "TaskDefinitions"
        Effect   = "Allow"
        Action   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition", "ecs:ListTaskDefinitions"]
        Resource = "*"
      },
      {
        Sid      = "Deploy"
        Effect   = "Allow"
        Action   = ["ecs:UpdateService", "ecs:DescribeServices"]
        Resource = [for s in [aws_ecs_service.api, aws_ecs_service.worker, aws_ecs_service.web] : s.id]
      },
      {
        Sid      = "ReleaseStep"
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = "arn:${local.partition}:ecs:${local.region}:${local.account_id}:task-definition/${local.prefix}-release:*"
        Condition = {
          ArnEquals = { "ecs:cluster" = aws_ecs_cluster.main.arn }
        }
      },
      {
        Sid      = "WatchTasks"
        Effect   = "Allow"
        Action   = ["ecs:DescribeTasks"]
        Resource = "arn:${local.partition}:ecs:${local.region}:${local.account_id}:task/${aws_ecs_cluster.main.name}/*"
      },
      {
        Sid    = "PassTaskRoles"
        Effect = "Allow"
        Action = "iam:PassRole"
        Resource = [
          aws_iam_role.execution.arn, aws_iam_role.app.arn, aws_iam_role.release.arn, aws_iam_role.web.arn,
        ]
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
      {
        Sid      = "ReleaseLogs"
        Effect   = "Allow"
        Action   = ["logs:GetLogEvents", "logs:FilterLogEvents"]
        Resource = "${aws_cloudwatch_log_group.app["release"].arn}:*"
      },
    ]
  })
}
