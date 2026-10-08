# The separate backup account (business continuity plan, section 3.2): one locked vault that
# production (and optionally staging) copy every backup into.

terraform {
  required_version = ">= 1.11"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.68"
    }
  }
  backend "s3" {
    key          = "backup/vault.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

variable "account_id" {
  type = string
}

variable "source_account_ids" {
  type = list(string)
}

provider "aws" {
  region              = "us-east-1"
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = { Application = "acct", Environment = "backup" }
  }
}

module "vault" {
  source             = "../../modules/backup-vault"
  source_account_ids = var.source_account_ids
}

output "vault_arn" {
  value = module.vault.vault_arn
}
