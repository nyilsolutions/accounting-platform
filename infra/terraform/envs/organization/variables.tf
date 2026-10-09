variable "management_account_id" {
  description = "The account this is applied from, which becomes the organization's management account."
  type        = string
}

variable "name" {
  type    = string
  default = "acct"
}

variable "account_emails" {
  description = "A unique email for each new account's root user (plus-addressing works, e.g. aws+production@example.com)."
  type        = object({ staging = string, production = string, backup = string })
}

variable "people" {
  description = "People who sign in through Identity Center, each in the admins or readonly group."
  type = list(object({
    email       = string
    given_name  = string
    family_name = string
    group       = string
  }))
  default = []
  validation {
    condition     = alltrue([for p in var.people : contains(["admins", "readonly"], p.group)])
    error_message = "Each person's group must be admins or readonly."
  }
}

variable "monthly_budget_usd" {
  description = "Monthly cost budget per account, in US dollars."
  type        = object({ staging = number, production = number, backup = number, management = number })
  default     = { staging = 500, production = 2500, backup = 200, management = 50 }
}

variable "budget_emails" {
  description = "Who gets budget alerts."
  type        = list(string)
}
