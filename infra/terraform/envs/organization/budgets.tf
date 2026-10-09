# A monthly cost budget per account (launch checklist section 1): an email at 80% of the
# forecast and at 100% of actual spend.

locals {
  budget_accounts = merge(
    { for env, a in aws_organizations_account.env : env => a.id },
    { management = var.management_account_id },
  )
}

resource "aws_budgets_budget" "account" {
  for_each     = local.budget_accounts
  name         = "acct-${each.key}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd[each.key])
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  cost_filter {
    name   = "LinkedAccount"
    values = [each.value]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = var.budget_emails
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = var.budget_emails
  }
}
