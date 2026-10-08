# IAM Identity Center (access control policy): people sign in once, with MFA, and get
# short-lived credentials for the accounts their group allows. There are no IAM users or
# long-lived keys in the member accounts.
#   acct-admins    AdministratorAccess in staging, production and backup (4-hour sessions)
#   acct-readonly  ReadOnlyAccess in staging, production and backup (8-hour sessions)
# Production access should stay with few people and be reviewed quarterly.

data "aws_ssoadmin_instances" "main" {}

locals {
  sso_instance_arn  = one(data.aws_ssoadmin_instances.main.arns)
  identity_store_id = one(data.aws_ssoadmin_instances.main.identity_store_ids)

  permission_sets = {
    admins   = { name = "AcctAdministrator", policy = "AdministratorAccess", session = "PT4H" }
    readonly = { name = "AcctReadOnly", policy = "ReadOnlyAccess", session = "PT8H" }
  }

  # group => account => permission set
  assignments = merge([
    for group in keys(local.permission_sets) : {
      for env in keys(local.accounts) : "${group}/${env}" => { group = group, env = env }
    }
  ]...)
}

resource "aws_ssoadmin_permission_set" "set" {
  for_each         = local.permission_sets
  name             = each.value.name
  description      = "acct: ${each.value.policy}"
  instance_arn     = local.sso_instance_arn
  session_duration = each.value.session
}

resource "aws_ssoadmin_managed_policy_attachment" "set" {
  for_each           = local.permission_sets
  instance_arn       = local.sso_instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.set[each.key].arn
  managed_policy_arn = "arn:${local.partition}:iam::aws:policy/${each.value.policy}"
}

resource "aws_identitystore_group" "group" {
  for_each          = local.permission_sets
  identity_store_id = local.identity_store_id
  display_name      = "acct-${each.key}"
  description       = "acct: ${each.value.policy} in every member account"
}

resource "aws_ssoadmin_account_assignment" "group" {
  for_each           = local.assignments
  instance_arn       = local.sso_instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.set[each.value.group].arn
  principal_type     = "GROUP"
  principal_id       = aws_identitystore_group.group[each.value.group].group_id
  target_type        = "AWS_ACCOUNT"
  target_id          = aws_organizations_account.env[each.value.env].id
  depends_on         = [aws_ssoadmin_managed_policy_attachment.set]
}

# People: Identity Center emails each one an invitation to set a password and an MFA device.
resource "aws_identitystore_user" "person" {
  for_each          = { for p in var.people : p.email => p }
  identity_store_id = local.identity_store_id
  user_name         = each.value.email
  display_name      = "${each.value.given_name} ${each.value.family_name}"
  name {
    given_name  = each.value.given_name
    family_name = each.value.family_name
  }
  emails {
    value   = each.value.email
    primary = true
  }
}

resource "aws_identitystore_group_membership" "person" {
  for_each          = { for p in var.people : p.email => p }
  identity_store_id = local.identity_store_id
  group_id          = aws_identitystore_group.group[each.value.group].group_id
  member_id         = aws_identitystore_user.person[each.key].user_id
}
