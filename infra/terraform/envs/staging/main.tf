# The staging environment (ADR 0030): its own AWS account, us-east-1, recovery region us-west-2.
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
    key          = "staging/platform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region              = "us-east-1"
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = { Application = "acct", Environment = "staging" }
  }
}

provider "aws" {
  alias               = "dr"
  region              = "us-west-2"
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = { Application = "acct", Environment = "staging" }
  }
}

variable "account_id" {
  description = "The staging AWS account; Terraform refuses to run against any other."
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
  description = "An existing hosted zone for the staging names. Leave null and set dns_zone_name to create one."
  type        = string
  default     = null
}

variable "dns_zone_name" {
  description = "A subdomain for staging (e.g. staging.example.com) to host in this account; production delegates it (staging_delegation there)."
  type        = string
  default     = null
}

# Staging's own zone: production's zone delegates the subdomain to these name servers.
resource "aws_route53_zone" "staging" {
  count   = var.dns_zone_name == null ? 0 : 1
  name    = var.dns_zone_name
  comment = "acct staging (delegated from production)"
}

output "dns_name_servers" {
  description = "Name servers for staging_delegation in envs/production."
  value       = var.dns_zone_name == null ? null : aws_route53_zone.staging[0].name_servers
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

variable "production_account_id" {
  description = "The production account, allowed to pull the images tested here."
  type        = string
  default     = null
}

module "platform" {
  source = "../../modules/platform"
  providers = {
    aws    = aws
    aws.dr = aws.dr
  }

  environment           = "staging"
  domain_name           = var.domain_name
  route53_zone_id       = var.dns_zone_name == null ? var.route53_zone_id : aws_route53_zone.staging[0].zone_id
  mail_domain           = var.mail_domain
  mail_from             = var.mail_from
  alarm_emails          = var.alarm_emails
  github_repository     = var.github_repository
  api_image             = var.api_image
  web_image             = var.web_image
  app_settings          = var.app_settings
  provider_secret_names = var.provider_secret_names

  # Cheaper than production: one NAT gateway, two zones, smaller database, single tasks.
  single_nat_gateway = true
  db_instance_class  = "db.t4g.medium"
  api_count          = 1
  web_count          = 1
  api_max_count      = 2
  # Production pulls the images staging tested.
  ecr_reader_account_ids = var.production_account_id == null ? [] : [var.production_account_id]
  # Staging can be torn down; production keeps everything.
  deletion_protection = false
}

output "platform" {
  value = module.platform
}
