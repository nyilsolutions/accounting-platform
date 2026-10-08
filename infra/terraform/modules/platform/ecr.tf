# Image repositories: immutable tags (a tag always means the same image), encrypted, scanned
# continuously by Amazon Inspector, and pruned to the last 100 images.

resource "aws_ecr_repository" "app" {
  for_each             = toset(["api", "web"])
  name                 = "${var.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.storage.arn
  }
  image_scanning_configuration {
    scan_on_push = true
  }
  tags = local.tags
}

resource "aws_ecr_lifecycle_policy" "app" {
  for_each   = aws_ecr_repository.app
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 100 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 100 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_ecr_registry_scanning_configuration" "main" {
  scan_type = "ENHANCED"
  rule {
    scan_frequency = "CONTINUOUS_SCAN"
    repository_filter {
      filter      = "${var.name}/*"
      filter_type = "WILDCARD"
    }
  }
}

# Production deploys the exact images staging tested: staging's repositories let the production
# account pull, and production's deploy role copies the image by digest (ADR 0030).
resource "aws_ecr_repository_policy" "readers" {
  for_each   = length(var.ecr_reader_account_ids) > 0 ? aws_ecr_repository.app : {}
  repository = each.value.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "OtherEnvironmentsPull"
      Effect    = "Allow"
      Principal = { AWS = [for id in var.ecr_reader_account_ids : "arn:${local.partition}:iam::${id}:root"] }
      Action    = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability", "ecr:DescribeImages"]
    }]
  })
}
