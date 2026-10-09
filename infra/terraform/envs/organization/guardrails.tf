# Service control policies: limits that hold for every person and role in the member accounts,
# administrators included (the management account is never limited by them).

locals {
  scp = {
    # No account leaves the organization (and with it, these policies).
    "deny-leave-organization" = {
      targets = ["Production", "Staging", "Security"]
      statements = [{
        Sid      = "DenyLeaveOrganization"
        Effect   = "Deny"
        Action   = "organizations:LeaveOrganization"
        Resource = "*"
      }]
    }
    # The root user of a member account is never used; people sign in through Identity Center.
    "deny-root-user" = {
      targets = ["Production", "Staging", "Security"]
      statements = [{
        Sid       = "DenyRootUser"
        Effect    = "Deny"
        Action    = "*"
        Resource  = "*"
        Condition = { StringLike = { "aws:PrincipalArn" = "arn:${local.partition}:iam::*:root" } }
      }]
    }
    # Workloads stay in the primary and recovery regions. Global services are exempt.
    "allowed-regions" = {
      targets = ["Production", "Staging", "Security"]
      statements = [{
        Sid    = "DenyOtherRegions"
        Effect = "Deny"
        NotAction = [
          "account:*", "acm:*", "budgets:*", "ce:*", "cloudfront:*", "health:*", "iam:*",
          "kms:*", "organizations:*", "route53:*", "route53domains:*", "s3:GetBucketLocation",
          "s3:ListAllMyBuckets", "sso:*", "sts:*", "support:*", "tag:*", "trustedadvisor:*",
          "waf:*", "wafv2:*",
        ]
        Resource  = "*"
        Condition = { StringNotEquals = { "aws:RequestedRegion" = local.allowed_regions } }
      }]
    }
    # What protects the data can't be switched off or destroyed, even by an administrator:
    # audit logging, threat detection, the field and storage keys (the business continuity
    # plan: the field key must never be deleted), backups and their vaults.
    "protect-security-and-data" = {
      targets = ["Production", "Security"]
      statements = [{
        Sid    = "DenyDisablingProtections"
        Effect = "Deny"
        Action = [
          "cloudtrail:StopLogging", "cloudtrail:DeleteTrail",
          "guardduty:DeleteDetector", "guardduty:DisassociateFromAdministratorAccount",
          "kms:ScheduleKeyDeletion", "kms:DisableKey",
          "backup:DeleteBackupVault", "backup:DeleteBackupVaultLockConfiguration",
          "backup:DeleteRecoveryPoint", "backup:UpdateRecoveryPointLifecycle",
          "rds:DeleteDBInstanceAutomatedBackup",
          "s3:DeleteBucket",
        ]
        Resource = "*"
      }]
    }
  }

  scp_attachments = merge([
    for name, p in local.scp : { for t in p.targets : "${name}/${t}" => { policy = name, ou = t } }
  ]...)
}

resource "aws_organizations_policy" "scp" {
  for_each    = local.scp
  name        = each.key
  description = "acct guardrail: ${each.key}"
  type        = "SERVICE_CONTROL_POLICY"
  content     = jsonencode({ Version = "2012-10-17", Statement = each.value.statements })
}

resource "aws_organizations_policy_attachment" "scp" {
  for_each  = local.scp_attachments
  policy_id = aws_organizations_policy.scp[each.value.policy].id
  target_id = aws_organizations_organizational_unit.ou[each.value.ou].id
}
