# The production environment (ADR 0030): its own AWS account, us-east-1, recovery region us-west-2.
#   terraform init -backend-config=backend.hcl
#   terraform apply
# backend.hcl and terraform.tfvars come from the .example files beside this one.

terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.68"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
  backend "s3" {
    key          = "production/platform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = "us-east-1"
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = { Application = "acct", Environment = "production" }
  }
}

provider "aws" {
  alias               = "dr"
  region              = "us-west-2"
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = { Application = "acct", Environment = "production" }
  }
}

variable "account_id" {
  description = "The production AWS account; Terraform refuses to run against any other."
  type        = string
}

variable "domain_name" {
  type = string
}

variable "mail_domain" {
  type = string
}

variable "mail_from" {
  type = string
}

variable "route53_zone_id" {
  description = "The domain's hosted zone in this account (Route 53 creates it when the domain is registered here)."
  type        = string
  default     = null
}

variable "staging_delegation" {
  description = "Delegates staging's subdomain to its zone in the staging account (its dns_name_servers output)."
  type        = object({ name = string, name_servers = list(string) })
  default     = null
}

resource "aws_route53_record" "staging_delegation" {
  count   = var.staging_delegation == null ? 0 : 1
  zone_id = var.route53_zone_id
  name    = var.staging_delegation.name
  type    = "NS"
  ttl     = 3600
  records = var.staging_delegation.name_servers
  lifecycle {
    precondition {
      condition     = var.route53_zone_id != null
      error_message = "staging_delegation needs route53_zone_id (the domain's zone)."
    }
  }
}

variable "alarm_emails" {
  type = list(string)
}

variable "github_repository" {
  type    = string
  default = "nyilsolutions/accounting-platform"
}

variable "api_image" {
  description = "The first API image; later deploys come from the deploy workflow."
  type        = string
}

variable "web_image" {
  type = string
}

variable "app_settings" {
  type    = map(string)
  default = {}
}

variable "provider_secret_names" {
  type    = list(string)
  default = []
}

variable "staging_account_id" {
  description = "The staging account, whose tested images production deploys."
  type        = string
}

variable "backup_account_vault_arn" {
  description = "The locked vault in the backup account (envs/backup). Null until it exists."
  type        = string
  default     = null
}

module "platform" {
  source = "../../modules/platform"
  providers = {
    aws    = aws
    aws.dr = aws.dr
  }

  environment           = "production"
  domain_name           = var.domain_name
  route53_zone_id       = var.route53_zone_id
  mail_domain           = var.mail_domain
  mail_from             = var.mail_from
  alarm_emails          = var.alarm_emails
  github_repository     = var.github_repository
  api_image             = var.api_image
  web_image             = var.web_image
  app_settings          = var.app_settings
  provider_secret_names = var.provider_secret_names

  az_count                 = 3
  image_source_account_id  = var.staging_account_id
  backup_account_vault_arn = var.backup_account_vault_arn
}

output "platform" {
  value = module.platform
}
