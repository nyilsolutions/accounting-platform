output "account_ids" {
  description = "account_id for envs/staging, envs/production and envs/backup."
  value       = { for env, a in aws_organizations_account.env : env => a.id }
}

output "identity_store_id" {
  value = local.identity_store_id
}

output "next_steps" {
  value = <<-EOT
    1. Each person accepts the Identity Center invitation and registers an MFA device.
    2. Configure the AWS CLI: aws configure sso (start URL: IAM Identity Center > Settings >
       AWS access portal URL), one profile per account: acct-staging, acct-production,
       acct-backup, using the AcctAdministrator permission set.
    3. Secure the management and member root users (MFA; store the credentials offline).
  EOT
}
