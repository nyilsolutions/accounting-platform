# One environment of the platform (ADR 0030): staging and production each apply this module in
# their own AWS account (envs/staging, envs/production).

variable "environment" {
  description = "staging or production."
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "name" {
  description = "Prefix for resource names."
  type        = string
  default     = "acct"
}

variable "domain_name" {
  description = "The app's host name, e.g. books.example.com (the ALB answers for it)."
  type        = string
}

variable "route53_zone_id" {
  description = "Hosted zone for domain_name and mail_domain. Null: create the DNS records by hand from the outputs."
  type        = string
  default     = null
}

variable "mail_domain" {
  description = "The domain mail is sent from (SES identity with DKIM), e.g. mail.example.com."
  type        = string
}

variable "mail_from" {
  description = "The From header, e.g. \"Books <no-reply@mail.example.com>\"."
  type        = string
}

variable "alarm_emails" {
  description = "Addresses subscribed to the alarm topic (each must confirm by email)."
  type        = list(string)
  default     = []
}

variable "github_repository" {
  description = "owner/name of the repository whose deploy workflow may deploy here (GitHub OIDC)."
  type        = string
}

variable "create_github_oidc_provider" {
  description = "Create the account's GitHub OIDC provider (false when one already exists)."
  type        = bool
  default     = true
}

# --- Network -------------------------------------------------------------------------------------

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "az_count" {
  description = "Availability zones used (2 or 3). RDS Multi-AZ needs at least 2."
  type        = number
  default     = 2
  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "single_nat_gateway" {
  description = "One NAT gateway for all zones (cheaper; staging). Production uses one per zone."
  type        = bool
  default     = false
}

variable "interface_endpoints" {
  description = "AWS services reached through interface VPC endpoints instead of the NAT gateway."
  type        = list(string)
  default     = ["ecr.api", "ecr.dkr", "logs", "secretsmanager", "kms", "sts"]
}

# --- Database ------------------------------------------------------------------------------------

variable "db_instance_class" {
  type    = string
  default = "db.m7g.large"
}

variable "db_allocated_storage" {
  description = "GiB to start with; storage grows on its own up to db_max_allocated_storage."
  type        = number
  default     = 100
}

variable "db_max_allocated_storage" {
  type    = number
  default = 1000
}

variable "db_engine_version" {
  description = "PostgreSQL major version (minor versions upgrade automatically)."
  type        = string
  default     = "16"
}

variable "db_backup_retention_days" {
  description = "Point-in-time recovery window, in this region and the recovery region (RDS allows up to 35)."
  type        = number
  default     = 35
}

variable "db_multi_az" {
  type    = bool
  default = true
}

variable "db_pool_size" {
  description = "Connections per API or worker task (DB_POOL_SIZE)."
  type        = number
  default     = 10
}

# --- Services ------------------------------------------------------------------------------------

variable "api_image" {
  description = "The API image (ECR URI with tag or digest). The deploy workflow sets new task definitions; this is the first one."
  type        = string
}

variable "web_image" {
  description = "The web image (ECR URI with tag or digest)."
  type        = string
}

variable "clamav_image" {
  description = "The clamd sidecar image. Mirror it into ECR (pull-through cache) for production."
  type        = string
  default     = "clamav/clamav:1.4"
}

variable "api_count" {
  type    = number
  default = 2
}

variable "web_count" {
  type    = number
  default = 2
}

variable "worker_count" {
  type    = number
  default = 1
}

variable "api_max_count" {
  description = "Most API tasks the CPU target tracking may run."
  type        = number
  default     = 6
}

variable "app_settings" {
  description = <<-EOT
    Extra plain environment variables for the API, worker and release tasks (not secrets), e.g.
    { BANK_FEED_PROVIDER = "plaid", PLAID_ENV = "production", PAYMENTS_PROVIDER = "stripe" }.
    The module sets the infrastructure ones (database, S3, KMS, mail, logs, providers default to none).
  EOT
  type        = map(string)
  default     = {}
}

variable "provider_secret_names" {
  description = <<-EOT
    Environment variables that hold provider credentials, e.g. ["STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET", "PLAID_CLIENT_ID", "PLAID_SECRET"]. An empty secret is created for
    each (acct/<env>/<NAME>); put its value in Secrets Manager before the services start.
  EOT
  type        = list(string)
  default     = []
}

variable "web_settings" {
  description = "Extra environment variables for the web tasks."
  type        = map(string)
  default     = {}
}

# --- Retention and recovery ----------------------------------------------------------------------

variable "log_retention_days" {
  description = "CloudWatch log retention ([Log Retention] in the logging policy)."
  type        = number
  default     = 365
}

variable "daily_backup_retention_days" {
  description = "Daily AWS Backup snapshots of the database ([Backup Retention])."
  type        = number
  default     = 35
}

variable "monthly_backup_retention_days" {
  description = "Monthly AWS Backup snapshots of the database ([Backup Retention])."
  type        = number
  default     = 365
}

variable "backup_account_vault_arn" {
  description = "A vault in the separate backup account (modules/backup-vault) that every backup is also copied to. Null until that account exists."
  type        = string
  default     = null
}

variable "deletion_protection" {
  description = "Protect the database, load balancer and buckets from deletion."
  type        = bool
  default     = true
}

variable "enable_account_security" {
  description = "Turn on CloudTrail (all regions), GuardDuty and IAM Access Analyzer for this account."
  type        = bool
  default     = true
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "db_passwords_version" {
  description = "Bump to generate new database passwords (the next deploy's release step applies the app role's)."
  type        = number
  default     = 1
}

variable "signing_key_version" {
  description = "Bump to generate a new SIGNING_KEY (outstanding download links and QuickBooks sign-ins stop working)."
  type        = number
  default     = 1
}

variable "ecr_reader_account_ids" {
  description = "Accounts allowed to pull this environment's images (staging: the production account)."
  type        = list(string)
  default     = []
}

variable "image_source_account_id" {
  description = "The account whose tested images this environment deploys (production: the staging account). Null: its own."
  type        = string
  default     = null
}

variable "waf_rate_limit" {
  description = "Requests per client IP in any 5 minutes before WAF blocks it (an office behind one IP counts once)."
  type        = number
  default     = 10000
}
