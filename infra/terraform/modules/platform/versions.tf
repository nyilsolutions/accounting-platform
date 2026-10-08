terraform {
  # 1.11: write-only attributes, so generated passwords and keys never reach the state.
  required_version = ">= 1.11"
  required_providers {
    aws = {
      source = "hashicorp/aws"
      # The disaster recovery region (backup copies, replicas) is the `aws.dr` provider.
      configuration_aliases = [aws.dr]
      version               = ">= 6.0, < 7.0"
    }
    # Ephemeral random_password (3.7+): generated locally on each run, never stored.
    random = {
      source  = "hashicorp/random"
      version = ">= 3.7, < 4.0"
    }
  }
}
