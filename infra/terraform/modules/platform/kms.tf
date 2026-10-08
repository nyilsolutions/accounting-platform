# Customer managed KMS keys, rotated yearly (encryption and key management policy):
#   field    - wraps the field data keys (FIELD_KMS_KEY_ID, ADR 0029). Multi-region, with a
#              replica in the recovery region, because the wrapped keys in `field_keys` are
#              useless without it (business continuity plan, section 3).
#   storage  - documents and exports in S3, and the AWS Backup vaults.
#   database - the RDS storage, its snapshots and Performance Insights.
#   logs     - CloudWatch log groups and the alarm topic.

locals {
  backup_account_id = var.backup_account_vault_arn == null ? null : split(":", var.backup_account_vault_arn)[4]
  key_admin_statement = {
    Sid       = "AccountAdministers"
    Effect    = "Allow"
    Principal = { AWS = "arn:${local.partition}:iam::${local.account_id}:root" }
    Action    = "kms:*"
    Resource  = "*"
  }
}

resource "aws_kms_key" "field" {
  description             = "${local.prefix}: wraps field encryption data keys"
  enable_key_rotation     = true
  multi_region            = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [local.key_admin_statement]
  })
  tags = local.tags
}

resource "aws_kms_alias" "field" {
  name          = "alias/${local.prefix}-field"
  target_key_id = aws_kms_key.field.key_id
}

resource "aws_kms_replica_key" "field_dr" {
  provider                = aws.dr
  description             = "${local.prefix}: field key replica for disaster recovery"
  primary_key_arn         = aws_kms_key.field.arn
  deletion_window_in_days = 30
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [local.key_admin_statement]
  })
  tags = local.tags
}

resource "aws_kms_key" "storage" {
  description             = "${local.prefix}: documents, exports and backups"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [local.key_admin_statement]
  })
  tags = local.tags
}

resource "aws_kms_alias" "storage" {
  name          = "alias/${local.prefix}-storage"
  target_key_id = aws_kms_key.storage.key_id
}

resource "aws_kms_key" "database" {
  description             = "${local.prefix}: database storage and snapshots"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([local.key_admin_statement], local.backup_account_id == null ? [] : [{
      # The backup account copies snapshots encrypted with this key into its own vault.
      Sid       = "BackupAccountCopies"
      Effect    = "Allow"
      Principal = { AWS = "arn:${local.partition}:iam::${local.backup_account_id}:root" }
      Action    = ["kms:Decrypt", "kms:DescribeKey", "kms:CreateGrant", "kms:ReEncrypt*", "kms:GenerateDataKey*"]
      Resource  = "*"
    }])
  })
  tags = local.tags
}

resource "aws_kms_alias" "database" {
  name          = "alias/${local.prefix}-database"
  target_key_id = aws_kms_key.database.key_id
}

resource "aws_kms_key" "logs" {
  description             = "${local.prefix}: logs and alarm notifications"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      local.key_admin_statement,
      {
        Sid       = "CloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${local.region}.amazonaws.com" }
        Action    = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
        Resource  = "*"
        Condition = {
          ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:${local.partition}:logs:${local.region}:${local.account_id}:*" }
        }
      },
      {
        # CloudWatch alarms, EventBridge rules and RDS events publish to the encrypted topic.
        Sid       = "AlarmPublishers"
        Effect    = "Allow"
        Principal = { Service = ["cloudwatch.amazonaws.com", "events.amazonaws.com", "events.rds.amazonaws.com", "backup.amazonaws.com", "ses.amazonaws.com"] }
        Action    = ["kms:Decrypt", "kms:GenerateDataKey*"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
      },
    ]
  })
  tags = local.tags
}

resource "aws_kms_alias" "logs" {
  name          = "alias/${local.prefix}-logs"
  target_key_id = aws_kms_key.logs.key_id
}

# Keys in the recovery region for the copies kept there.
resource "aws_kms_key" "dr_backup" {
  provider                = aws.dr
  description             = "${local.prefix}: database backups and document copies in the recovery region"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [local.key_admin_statement]
  })
  tags = local.tags
}

resource "aws_kms_alias" "dr_backup" {
  provider      = aws.dr
  name          = "alias/${local.prefix}-dr-backup"
  target_key_id = aws_kms_key.dr_backup.key_id
}
