# Account-level detection (logging and monitoring policy): CloudTrail in every region with log
# file validation, GuardDuty (findings go to the alarm topic, monitoring.tf) and IAM Access
# Analyzer. Turn off with enable_account_security when the organization already provides them.

resource "aws_cloudtrail" "main" {
  count                         = var.enable_account_security ? 1 : 0
  name                          = local.prefix
  s3_bucket_name                = aws_s3_bucket.logs.id
  s3_key_prefix                 = "cloudtrail"
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true
  # Reads and writes of documents in S3 are recorded too.
  event_selector {
    read_write_type           = "All"
    include_management_events = true
    data_resource {
      type   = "AWS::S3::Object"
      values = ["${aws_s3_bucket.documents.arn}/"]
    }
  }
  tags       = local.tags
  depends_on = [aws_s3_bucket_policy.logs]
}

resource "aws_guardduty_detector" "main" {
  count  = var.enable_account_security ? 1 : 0
  enable = true
  tags   = local.tags
}

resource "aws_guardduty_detector_feature" "main" {
  for_each    = var.enable_account_security ? toset(["S3_DATA_EVENTS", "RDS_LOGIN_EVENTS", "RUNTIME_MONITORING"]) : toset([])
  detector_id = aws_guardduty_detector.main[0].id
  name        = each.key
  status      = "ENABLED"
  dynamic "additional_configuration" {
    for_each = each.key == "RUNTIME_MONITORING" ? ["ECS_FARGATE_AGENT_MANAGEMENT"] : []
    content {
      name   = additional_configuration.value
      status = "ENABLED"
    }
  }
}

resource "aws_accessanalyzer_analyzer" "main" {
  count         = var.enable_account_security ? 1 : 0
  analyzer_name = local.prefix
  type          = "ACCOUNT"
  tags          = local.tags
}
