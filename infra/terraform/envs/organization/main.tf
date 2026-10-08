# The AWS Organization (launch checklist section 1), applied once from the management account:
# the organization, staging, production and backup accounts, guardrail policies, cross-account
# backup, a monthly budget per account, and IAM Identity Center groups with access to each
# account. Nothing runs in the management account; it holds the organization and billing only.
#
#   terraform init -backend-config=backend.hcl
#   terraform apply
#
# Before the first apply, turn on IAM Identity Center in the console (one click, "Enable",
# organization instance, region us-east-1): it can't be created by Terraform.

terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.68"
    }
  }
  backend "s3" {
    key          = "organization/organization.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = "us-east-1"
  allowed_account_ids = [var.management_account_id]
  default_tags {
    tags = { Application = "acct", Environment = "organization" }
  }
}

data "aws_partition" "current" {}

locals {
  partition = data.aws_partition.current.partition
  # Regions the workloads may use (ADR 0030): the primary and the recovery region.
  allowed_regions = ["us-east-1", "us-west-2"]
}

# --- Organization and accounts ---------------------------------------------------------------

resource "aws_organizations_organization" "main" {
  feature_set = "ALL"
  aws_service_access_principals = [
    "backup.amazonaws.com",
    "sso.amazonaws.com",
    "account.amazonaws.com",
  ]
  enabled_policy_types = ["SERVICE_CONTROL_POLICY"]
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_organizations_organizational_unit" "ou" {
  for_each  = toset(["Production", "Staging", "Security"])
  name      = each.key
  parent_id = aws_organizations_organization.main.roots[0].id
}

locals {
  accounts = {
    staging    = { name = "${var.name}-staging", ou = "Staging" }
    production = { name = "${var.name}-production", ou = "Production" }
    backup     = { name = "${var.name}-backup", ou = "Security" }
  }
}

# Each account's root user email must be unique and reach a person (it receives the account's
# security and billing mail). Closing an account is a decision for a person, never Terraform.
resource "aws_organizations_account" "env" {
  for_each                   = local.accounts
  name                       = each.value.name
  email                      = var.account_emails[each.key]
  parent_id                  = aws_organizations_organizational_unit.ou[each.value.ou].id
  role_name                  = "OrganizationAccountAccessRole"
  iam_user_access_to_billing = "DENY"
  close_on_deletion          = false
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [role_name, iam_user_access_to_billing]
  }
}

# Backups are copied into the backup account's locked vault (envs/backup).
resource "aws_backup_global_settings" "main" {
  global_settings = {
    isCrossAccountBackupEnabled = "true"
  }
  depends_on = [aws_organizations_organization.main]
}
