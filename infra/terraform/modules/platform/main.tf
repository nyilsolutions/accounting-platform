data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
data "aws_region" "dr" {
  provider = aws.dr
}
data "aws_partition" "current" {}
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  prefix     = "${var.name}-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
  dr_region  = data.aws_region.dr.region
  partition  = data.aws_partition.current.partition
  azs        = slice(data.aws_availability_zones.available.names, 0, var.az_count)
  tags = merge(var.tags, {
    Application = var.name
    Environment = var.environment
    ManagedBy   = "terraform"
  })
  # Secrets Manager names: acct/<environment>/<NAME>.
  secret_prefix = "${var.name}/${var.environment}"
}
