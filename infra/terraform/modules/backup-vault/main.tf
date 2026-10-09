# The vault in the separate backup account (business continuity plan, section 3.2): every
# environment copies its backups here, and vault lock in compliance mode means no one, not
# even this account's root user, can delete a copy before its retention ends.
#
# Cross-account copies need AWS Organizations with cross-account backup turned on (in the
# management account: AWS Backup > Settings > Cross-account backup).

terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
  }
}

variable "name" {
  type    = string
  default = "acct-backups"
}

variable "source_account_ids" {
  description = "Accounts whose backups are copied here (production, and staging if wanted)."
  type        = list(string)
}

variable "min_retention_days" {
  description = "Shortest retention a copy may have."
  type        = number
  default     = 7
}

variable "max_retention_days" {
  description = "Longest retention a copy may have: 7 years, the monthly snapshots' retention."
  type        = number
  default     = 2555
}

variable "lock_changeable_for_days" {
  description = "Days the lock can still be removed after it is applied (at least 3). After that it is permanent."
  type        = number
  default     = 3
}

variable "tags" {
  type    = map(string)
  default = {}
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  partition = data.aws_partition.current.partition
}

resource "aws_kms_key" "vault" {
  description             = "${var.name}: backup copies"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdministers"
        Effect    = "Allow"
        Principal = { AWS = "arn:${local.partition}:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "SourceAccountsCopy"
        Effect    = "Allow"
        Principal = { AWS = [for id in var.source_account_ids : "arn:${local.partition}:iam::${id}:root"] }
        Action    = ["kms:DescribeKey", "kms:Encrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:CreateGrant"]
        Resource  = "*"
      },
    ]
  })
  tags = var.tags
}

resource "aws_backup_vault" "main" {
  name        = var.name
  kms_key_arn = aws_kms_key.vault.arn
  tags        = var.tags
}

resource "aws_backup_vault_policy" "main" {
  backup_vault_name = aws_backup_vault.main.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SourceAccountsCopyIn"
      Effect    = "Allow"
      Principal = { AWS = [for id in var.source_account_ids : "arn:${local.partition}:iam::${id}:root"] }
      Action    = "backup:CopyIntoBackupVault"
      Resource  = "*"
    }]
  })
}

resource "aws_backup_vault_lock_configuration" "main" {
  backup_vault_name   = aws_backup_vault.main.name
  min_retention_days  = var.min_retention_days
  max_retention_days  = var.max_retention_days
  changeable_for_days = var.lock_changeable_for_days
}

output "vault_arn" {
  description = "backup_account_vault_arn for the environments."
  value       = aws_backup_vault.main.arn
}
