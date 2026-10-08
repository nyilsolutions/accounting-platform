# `terraform test` (offline): applies the organization root to a mocked AWS provider (nothing is
# created) and checks the guardrails, access and budgets. Run from envs/organization:
#   terraform init -backend=false && terraform test

mock_provider "aws" {
  override_data {
    target = data.aws_partition.current
    values = { partition = "aws" }
  }
  override_data {
    target = data.aws_ssoadmin_instances.main
    values = {
      arns               = ["arn:aws:sso:::instance/ssoins-1111111111111111"]
      identity_store_ids = ["d-1111111111"]
    }
  }
  mock_resource "aws_organizations_account" {
    defaults = { id = "222222222222", arn = "arn:aws:organizations::000000000000:account/o-mock/222222222222" }
  }
  mock_resource "aws_organizations_organization" {
    defaults = {
      arn   = "arn:aws:organizations::000000000000:organization/o-mock"
      roots = [{ id = "r-mock", arn = "arn:aws:organizations::000000000000:root/o-mock/r-mock", name = "Root", policy_types = [] }]
    }
  }
  mock_resource "aws_organizations_organizational_unit" {
    defaults = { id = "ou-mock-11111111", arn = "arn:aws:organizations::000000000000:ou/o-mock/ou-mock-11111111" }
  }
  mock_resource "aws_organizations_policy" {
    defaults = { id = "p-11111111", arn = "arn:aws:organizations::000000000000:policy/o-mock/service_control_policy/p-11111111" }
  }
  mock_resource "aws_identitystore_group" {
    defaults = { group_id = "1111111111-11111111-1111-1111-1111-111111111111" }
  }
  mock_resource "aws_identitystore_user" {
    defaults = { user_id = "1111111111-22222222-2222-2222-2222-222222222222" }
  }
  mock_resource "aws_ssoadmin_permission_set" {
    defaults = { arn = "arn:aws:sso:::permissionSet/ssoins-1111111111111111/ps-1111111111111111" }
  }
}

variables {
  management_account_id = "000000000000"
  account_emails = {
    staging    = "aws+staging@example.com"
    production = "aws+production@example.com"
    backup     = "aws+backup@example.com"
  }
  people = [
    { email = "admin@example.com", given_name = "Ada", family_name = "Admin", group = "admins" },
    { email = "viewer@example.com", given_name = "Vic", family_name = "Viewer", group = "readonly" },
  ]
  budget_emails = ["admin@example.com"]
}

run "organization" {
  command = apply

  assert {
    condition     = aws_organizations_organization.main.feature_set == "ALL" && contains(aws_organizations_organization.main.enabled_policy_types, "SERVICE_CONTROL_POLICY")
    error_message = "All features with service control policies."
  }
  assert {
    condition     = length(aws_organizations_account.env) == 3 && alltrue([for a in aws_organizations_account.env : !a.close_on_deletion])
    error_message = "Three accounts, never closed by Terraform."
  }
  assert {
    condition     = aws_backup_global_settings.main.global_settings.isCrossAccountBackupEnabled == "true"
    error_message = "Cross-account backup is on (the backup account's vault)."
  }
  assert {
    condition     = length(aws_organizations_policy_attachment.scp) == 11
    error_message = "Leave, root and region guardrails on all three OUs; data protection on Production and Security."
  }
  assert {
    condition     = !contains(keys(aws_organizations_policy_attachment.scp), "protect-security-and-data/Staging")
    error_message = "Staging can still be torn down."
  }
  assert {
    condition     = contains(jsondecode(aws_organizations_policy.scp["protect-security-and-data"].content).Statement[0].Action, "kms:ScheduleKeyDeletion")
    error_message = "Production keys can't be scheduled for deletion."
  }
  assert {
    condition     = jsondecode(aws_organizations_policy.scp["allowed-regions"].content).Statement[0].Condition.StringNotEquals["aws:RequestedRegion"] == ["us-east-1", "us-west-2"]
    error_message = "Only the primary and recovery regions."
  }
  assert {
    condition     = length(aws_ssoadmin_account_assignment.group) == 6
    error_message = "Each group reaches each member account."
  }
  assert {
    condition     = aws_ssoadmin_permission_set.set["admins"].session_duration == "PT4H"
    error_message = "Administrator sessions last at most 4 hours."
  }
  assert {
    condition     = length(aws_budgets_budget.account) == 4
    error_message = "A budget per account, management included."
  }
}

run "people_belong_to_a_known_group" {
  command = plan
  variables {
    people = [{ email = "x@example.com", given_name = "X", family_name = "Y", group = "everyone" }]
  }
  expect_failures = [var.people]
}
