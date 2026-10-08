# Backups (business continuity plan, section 3):
#   - RDS automated backups: point-in-time recovery for db_backup_retention_days, here and in
#     the recovery region (database.tf).
#   - AWS Backup: daily and monthly snapshots, each copied to the recovery region and, once it
#     exists, to the separate backup account's locked vault (modules/backup-vault), which
#     production credentials can't delete from.
#   - Documents: S3 versioning and replication to the recovery region (storage.tf).
# Failed backup and copy jobs notify the alarm topic.

resource "aws_backup_vault" "main" {
  name        = local.prefix
  kms_key_arn = aws_kms_key.storage.arn
  tags        = local.tags
}

resource "aws_backup_vault" "dr" {
  provider    = aws.dr
  name        = "${local.prefix}-dr"
  kms_key_arn = aws_kms_key.dr_backup.arn
  tags        = local.tags
}

locals {
  backup_copy_targets = compact([aws_backup_vault.dr.arn, var.backup_account_vault_arn])
}

resource "aws_backup_plan" "main" {
  name = local.prefix

  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.main.name
    schedule          = "cron(0 9 * * ? *)"
    start_window      = 60
    completion_window = 360
    lifecycle {
      delete_after = var.daily_backup_retention_days
    }
    dynamic "copy_action" {
      for_each = local.backup_copy_targets
      content {
        destination_vault_arn = copy_action.value
        lifecycle {
          delete_after = var.daily_backup_retention_days
        }
      }
    }
    recovery_point_tags = merge(local.tags, { Schedule = "daily" })
  }

  rule {
    rule_name         = "monthly"
    target_vault_name = aws_backup_vault.main.name
    schedule          = "cron(0 10 1 * ? *)"
    start_window      = 60
    completion_window = 720
    lifecycle {
      delete_after = var.monthly_backup_retention_days
    }
    dynamic "copy_action" {
      for_each = local.backup_copy_targets
      content {
        destination_vault_arn = copy_action.value
        lifecycle {
          delete_after = var.monthly_backup_retention_days
        }
      }
    }
    recovery_point_tags = merge(local.tags, { Schedule = "monthly" })
  }

  tags = local.tags
}

resource "aws_iam_role" "backup" {
  name = "${local.prefix}-backup"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "backup.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "backup" {
  for_each = toset([
    "arn:${local.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup",
    "arn:${local.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores",
  ])
  role       = aws_iam_role.backup.name
  policy_arn = each.key
}

# Copies are re-encrypted with the destination vault's key; the source snapshots use the
# database key, which AWS Backup needs to read.
resource "aws_iam_role_policy" "backup_keys" {
  name = "backup-keys"
  role = aws_iam_role.backup.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*", "kms:DescribeKey", "kms:CreateGrant"]
      Resource = [aws_kms_key.database.arn, aws_kms_key.storage.arn, aws_kms_key.dr_backup.arn]
    }]
  })
}

resource "aws_backup_selection" "database" {
  name         = "${local.prefix}-database"
  plan_id      = aws_backup_plan.main.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [aws_db_instance.main.arn]
}

resource "aws_backup_vault_notifications" "main" {
  backup_vault_name   = aws_backup_vault.main.name
  sns_topic_arn       = aws_sns_topic.alarms.arn
  backup_vault_events = ["BACKUP_JOB_FAILED", "BACKUP_JOB_EXPIRED", "COPY_JOB_FAILED", "RESTORE_JOB_FAILED"]
}
