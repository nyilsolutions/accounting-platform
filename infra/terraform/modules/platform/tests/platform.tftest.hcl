# `terraform test` (offline): applies the module to mocked AWS providers (nothing is created) and checks the
# settings the security and continuity policies depend on. Run from modules/platform:
#   terraform init -backend=false && terraform test

mock_provider "aws" {
  # Resources answer with ARN-shaped values (the provider checks ARNs it is given).
  mock_resource "aws_accessanalyzer_analyzer" {
    defaults = { arn = "arn:aws:accessanalyzer:us-east-1:111111111111:accessanalyzer_analyzer/mock" }
  }
  mock_resource "aws_acm_certificate" {
    defaults = { arn = "arn:aws:acm:us-east-1:111111111111:acm_certificate/mock" }
  }
  mock_resource "aws_appautoscaling_policy" {
    defaults = { arn = "arn:aws:appautoscaling:us-east-1:111111111111:appautoscaling_policy/mock" }
  }
  mock_resource "aws_appautoscaling_target" {
    defaults = { arn = "arn:aws:appautoscaling:us-east-1:111111111111:appautoscaling_target/mock" }
  }
  mock_resource "aws_backup_plan" {
    defaults = { arn = "arn:aws:backup:us-east-1:111111111111:backup_plan/mock" }
  }
  mock_resource "aws_backup_vault" {
    defaults = { arn = "arn:aws:backup:us-east-1:111111111111:backup_vault/mock" }
  }
  mock_resource "aws_cloudtrail" {
    defaults = { arn = "arn:aws:cloudtrail:us-east-1:111111111111:cloudtrail/mock" }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:cloudwatch:us-east-1:111111111111:cloudwatch_event_rule/mock" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:cloudwatch:us-east-1:111111111111:cloudwatch_log_group/mock" }
  }
  mock_resource "aws_cloudwatch_metric_alarm" {
    defaults = { arn = "arn:aws:cloudwatch:us-east-1:111111111111:cloudwatch_metric_alarm/mock" }
  }
  mock_resource "aws_db_event_subscription" {
    defaults = { arn = "arn:aws:db:us-east-1:111111111111:db_event_subscription/mock" }
  }
  mock_resource "aws_db_instance" {
    defaults = { arn = "arn:aws:db:us-east-1:111111111111:db_instance/mock" }
  }
  mock_resource "aws_db_parameter_group" {
    defaults = { arn = "arn:aws:db:us-east-1:111111111111:db_parameter_group/mock" }
  }
  mock_resource "aws_db_subnet_group" {
    defaults = { arn = "arn:aws:db:us-east-1:111111111111:db_subnet_group/mock" }
  }
  mock_resource "aws_default_security_group" {
    defaults = { arn = "arn:aws:default:us-east-1:111111111111:default_security_group/mock" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = { arn = "arn:aws:ecr:us-east-1:111111111111:ecr_repository/mock" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:us-east-1:111111111111:ecs_cluster/mock" }
  }
  mock_resource "aws_ecs_service" {
    defaults = { arn = "arn:aws:ecs:us-east-1:111111111111:ecs_service/mock" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:us-east-1:111111111111:ecs_task_definition/mock" }
  }
  mock_resource "aws_eip" {
    defaults = { arn = "arn:aws:eip:us-east-1:111111111111:eip/mock" }
  }
  mock_resource "aws_flow_log" {
    defaults = { arn = "arn:aws:flow:us-east-1:111111111111:flow_log/mock" }
  }
  mock_resource "aws_guardduty_detector" {
    defaults = { arn = "arn:aws:guardduty:us-east-1:111111111111:guardduty_detector/mock" }
  }
  mock_resource "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam:us-east-1:111111111111:iam_openid_connect_provider/mock" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam:us-east-1:111111111111:iam_role/mock" }
  }
  mock_resource "aws_internet_gateway" {
    defaults = { arn = "arn:aws:internet:us-east-1:111111111111:internet_gateway/mock" }
  }
  mock_resource "aws_kms_alias" {
    defaults = { arn = "arn:aws:kms:us-east-1:111111111111:kms_alias/mock" }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:us-east-1:111111111111:kms_key/mock" }
  }
  mock_resource "aws_kms_replica_key" {
    defaults = { arn = "arn:aws:kms:us-east-1:111111111111:kms_replica_key/mock" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:lb:us-east-1:111111111111:lb/mock" }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:lb:us-east-1:111111111111:lb_listener/mock" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:lb:us-east-1:111111111111:lb_target_group/mock" }
  }
  mock_resource "aws_route_table" {
    defaults = { arn = "arn:aws:route:us-east-1:111111111111:route_table/mock" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:us-east-1:111111111111:s3_bucket/mock" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-east-1:111111111111:secretsmanager_secret/mock" }
  }
  mock_resource "aws_secretsmanager_secret_version" {
    defaults = { arn = "arn:aws:secretsmanager:us-east-1:111111111111:secretsmanager_secret_version/mock" }
  }
  mock_resource "aws_security_group" {
    defaults = { arn = "arn:aws:security:us-east-1:111111111111:security_group/mock" }
  }
  mock_resource "aws_service_discovery_private_dns_namespace" {
    defaults = { arn = "arn:aws:service:us-east-1:111111111111:service_discovery_private_dns_namespace/mock" }
  }
  mock_resource "aws_service_discovery_service" {
    defaults = { arn = "arn:aws:service:us-east-1:111111111111:service_discovery_service/mock" }
  }
  mock_resource "aws_sesv2_configuration_set" {
    defaults = { arn = "arn:aws:sesv2:us-east-1:111111111111:sesv2_configuration_set/mock" }
  }
  mock_resource "aws_sesv2_email_identity" {
    defaults = { arn = "arn:aws:sesv2:us-east-1:111111111111:sesv2_email_identity/mock" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-1:111111111111:sns_topic/mock" }
  }
  mock_resource "aws_sns_topic_subscription" {
    defaults = { arn = "arn:aws:sns:us-east-1:111111111111:sns_topic_subscription/mock" }
  }
  mock_resource "aws_subnet" {
    defaults = { arn = "arn:aws:subnet:us-east-1:111111111111:subnet/mock" }
  }
  mock_resource "aws_vpc" {
    defaults = { arn = "arn:aws:vpc:us-east-1:111111111111:vpc/mock" }
  }
  mock_resource "aws_vpc_endpoint" {
    defaults = { arn = "arn:aws:vpc:us-east-1:111111111111:vpc_endpoint/mock" }
  }
  mock_resource "aws_vpc_security_group_egress_rule" {
    defaults = { arn = "arn:aws:vpc:us-east-1:111111111111:vpc_security_group_egress_rule/mock" }
  }
  mock_resource "aws_vpc_security_group_ingress_rule" {
    defaults = { arn = "arn:aws:vpc:us-east-1:111111111111:vpc_security_group_ingress_rule/mock" }
  }
  mock_resource "aws_wafv2_web_acl" {
    defaults = { arn = "arn:aws:wafv2:us-east-1:111111111111:wafv2_web_acl/mock" }
  }
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "111111111111" }
  }
  override_data {
    target = data.aws_region.current
    values = { region = "us-east-1" }
  }
  override_data {
    target = data.aws_partition.current
    values = { partition = "aws" }
  }
  override_data {
    target = data.aws_availability_zones.available
    values = { names = ["us-east-1a", "us-east-1b", "us-east-1c"] }
  }
}

mock_provider "aws" {
  alias = "dr"
  mock_resource "aws_accessanalyzer_analyzer" {
    defaults = { arn = "arn:aws:accessanalyzer:us-west-2:111111111111:accessanalyzer_analyzer/mock" }
  }
  mock_resource "aws_acm_certificate" {
    defaults = { arn = "arn:aws:acm:us-west-2:111111111111:acm_certificate/mock" }
  }
  mock_resource "aws_appautoscaling_policy" {
    defaults = { arn = "arn:aws:appautoscaling:us-west-2:111111111111:appautoscaling_policy/mock" }
  }
  mock_resource "aws_appautoscaling_target" {
    defaults = { arn = "arn:aws:appautoscaling:us-west-2:111111111111:appautoscaling_target/mock" }
  }
  mock_resource "aws_backup_plan" {
    defaults = { arn = "arn:aws:backup:us-west-2:111111111111:backup_plan/mock" }
  }
  mock_resource "aws_backup_vault" {
    defaults = { arn = "arn:aws:backup:us-west-2:111111111111:backup_vault/mock" }
  }
  mock_resource "aws_cloudtrail" {
    defaults = { arn = "arn:aws:cloudtrail:us-west-2:111111111111:cloudtrail/mock" }
  }
  mock_resource "aws_cloudwatch_event_rule" {
    defaults = { arn = "arn:aws:cloudwatch:us-west-2:111111111111:cloudwatch_event_rule/mock" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:cloudwatch:us-west-2:111111111111:cloudwatch_log_group/mock" }
  }
  mock_resource "aws_cloudwatch_metric_alarm" {
    defaults = { arn = "arn:aws:cloudwatch:us-west-2:111111111111:cloudwatch_metric_alarm/mock" }
  }
  mock_resource "aws_db_event_subscription" {
    defaults = { arn = "arn:aws:db:us-west-2:111111111111:db_event_subscription/mock" }
  }
  mock_resource "aws_db_instance" {
    defaults = { arn = "arn:aws:db:us-west-2:111111111111:db_instance/mock" }
  }
  mock_resource "aws_db_parameter_group" {
    defaults = { arn = "arn:aws:db:us-west-2:111111111111:db_parameter_group/mock" }
  }
  mock_resource "aws_db_subnet_group" {
    defaults = { arn = "arn:aws:db:us-west-2:111111111111:db_subnet_group/mock" }
  }
  mock_resource "aws_default_security_group" {
    defaults = { arn = "arn:aws:default:us-west-2:111111111111:default_security_group/mock" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = { arn = "arn:aws:ecr:us-west-2:111111111111:ecr_repository/mock" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:us-west-2:111111111111:ecs_cluster/mock" }
  }
  mock_resource "aws_ecs_service" {
    defaults = { arn = "arn:aws:ecs:us-west-2:111111111111:ecs_service/mock" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:us-west-2:111111111111:ecs_task_definition/mock" }
  }
  mock_resource "aws_eip" {
    defaults = { arn = "arn:aws:eip:us-west-2:111111111111:eip/mock" }
  }
  mock_resource "aws_flow_log" {
    defaults = { arn = "arn:aws:flow:us-west-2:111111111111:flow_log/mock" }
  }
  mock_resource "aws_guardduty_detector" {
    defaults = { arn = "arn:aws:guardduty:us-west-2:111111111111:guardduty_detector/mock" }
  }
  mock_resource "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam:us-west-2:111111111111:iam_openid_connect_provider/mock" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam:us-west-2:111111111111:iam_role/mock" }
  }
  mock_resource "aws_internet_gateway" {
    defaults = { arn = "arn:aws:internet:us-west-2:111111111111:internet_gateway/mock" }
  }
  mock_resource "aws_kms_alias" {
    defaults = { arn = "arn:aws:kms:us-west-2:111111111111:kms_alias/mock" }
  }
  mock_resource "aws_kms_key" {
    defaults = { arn = "arn:aws:kms:us-west-2:111111111111:kms_key/mock" }
  }
  mock_resource "aws_kms_replica_key" {
    defaults = { arn = "arn:aws:kms:us-west-2:111111111111:kms_replica_key/mock" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:lb:us-west-2:111111111111:lb/mock" }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:lb:us-west-2:111111111111:lb_listener/mock" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:lb:us-west-2:111111111111:lb_target_group/mock" }
  }
  mock_resource "aws_route_table" {
    defaults = { arn = "arn:aws:route:us-west-2:111111111111:route_table/mock" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:us-west-2:111111111111:s3_bucket/mock" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:us-west-2:111111111111:secretsmanager_secret/mock" }
  }
  mock_resource "aws_secretsmanager_secret_version" {
    defaults = { arn = "arn:aws:secretsmanager:us-west-2:111111111111:secretsmanager_secret_version/mock" }
  }
  mock_resource "aws_security_group" {
    defaults = { arn = "arn:aws:security:us-west-2:111111111111:security_group/mock" }
  }
  mock_resource "aws_service_discovery_private_dns_namespace" {
    defaults = { arn = "arn:aws:service:us-west-2:111111111111:service_discovery_private_dns_namespace/mock" }
  }
  mock_resource "aws_service_discovery_service" {
    defaults = { arn = "arn:aws:service:us-west-2:111111111111:service_discovery_service/mock" }
  }
  mock_resource "aws_sesv2_configuration_set" {
    defaults = { arn = "arn:aws:sesv2:us-west-2:111111111111:sesv2_configuration_set/mock" }
  }
  mock_resource "aws_sesv2_email_identity" {
    defaults = { arn = "arn:aws:sesv2:us-west-2:111111111111:sesv2_email_identity/mock" }
  }
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-west-2:111111111111:sns_topic/mock" }
  }
  mock_resource "aws_sns_topic_subscription" {
    defaults = { arn = "arn:aws:sns:us-west-2:111111111111:sns_topic_subscription/mock" }
  }
  mock_resource "aws_subnet" {
    defaults = { arn = "arn:aws:subnet:us-west-2:111111111111:subnet/mock" }
  }
  mock_resource "aws_vpc" {
    defaults = { arn = "arn:aws:vpc:us-west-2:111111111111:vpc/mock" }
  }
  mock_resource "aws_vpc_endpoint" {
    defaults = { arn = "arn:aws:vpc:us-west-2:111111111111:vpc_endpoint/mock" }
  }
  mock_resource "aws_vpc_security_group_egress_rule" {
    defaults = { arn = "arn:aws:vpc:us-west-2:111111111111:vpc_security_group_egress_rule/mock" }
  }
  mock_resource "aws_vpc_security_group_ingress_rule" {
    defaults = { arn = "arn:aws:vpc:us-west-2:111111111111:vpc_security_group_ingress_rule/mock" }
  }
  mock_resource "aws_wafv2_web_acl" {
    defaults = { arn = "arn:aws:wafv2:us-west-2:111111111111:wafv2_web_acl/mock" }
  }
  override_data {
    target = data.aws_region.dr
    values = { region = "us-west-2" }
  }
}

variables {
  environment       = "production"
  domain_name       = "books.example.com"
  mail_domain       = "mail.example.com"
  mail_from         = "Books <no-reply@mail.example.com>"
  github_repository = "example/accounting-platform"
  api_image         = "111111111111.dkr.ecr.us-east-1.amazonaws.com/acct/api:abc"
  web_image         = "111111111111.dkr.ecr.us-east-1.amazonaws.com/acct/web:abc"
  alarm_emails      = ["ops@example.com"]
}

run "production_defaults" {
  command = apply

  assert {
    condition     = aws_db_instance.main.multi_az && aws_db_instance.main.storage_encrypted && !aws_db_instance.main.publicly_accessible
    error_message = "The database must be Multi-AZ, encrypted and private."
  }
  assert {
    condition     = aws_db_instance.main.backup_retention_period == 35 && aws_db_instance.main.deletion_protection
    error_message = "Point-in-time recovery for 35 days, with deletion protection."
  }
  assert {
    condition     = one([for p in aws_db_parameter_group.main.parameter : p.value if p.name == "rds.force_ssl"]) == "1"
    error_message = "The database must refuse connections without TLS."
  }
  assert {
    condition     = aws_kms_key.field.multi_region && aws_kms_key.field.enable_key_rotation
    error_message = "The field key must be multi-region (recovery region) and rotated."
  }
  assert {
    condition     = length(aws_subnet.app) == 2 && length(aws_nat_gateway.main) == 2
    error_message = "Two zones, a NAT gateway in each, by default."
  }
  assert {
    condition     = alltrue([for s in aws_subnet.public : !s.map_public_ip_on_launch])
    error_message = "Nothing gets a public IP by default."
  }
  assert {
    condition     = aws_lb.main.drop_invalid_header_fields && aws_lb_listener.https.ssl_policy == "ELBSecurityPolicy-TLS13-1-2-Res-2021-06"
    error_message = "The load balancer drops invalid headers and offers TLS 1.2 and 1.3 only."
  }
  assert {
    condition     = one(aws_lb_listener.http.default_action).type == "redirect"
    error_message = "HTTP only redirects to HTTPS."
  }
  assert {
    condition     = jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:example/accounting-platform:environment:production"
    error_message = "Only the repository's production environment may deploy to production."
  }
  assert {
    condition     = length([for c in jsondecode(aws_ecs_task_definition.api.container_definitions) : c if c.name == "clamd"]) == 1
    error_message = "The API runs with clamd beside it."
  }
  assert {
    condition     = one([for e in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : e.value if e.name == "TRUST_PROXY"]) == "loopback, 10.40.0.0/16"
    error_message = "The API trusts only hops inside the VPC for X-Forwarded-For."
  }
  assert {
    condition     = one([for e in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].environment : e.value if e.name == "NODE_ENV"]) == "production"
    error_message = "Production settings (and their start-up checks) apply."
  }
  assert {
    condition     = alltrue([for c in jsondecode(aws_ecs_task_definition.api.container_definitions) : c.name == "clamd" || (c.user == "1000" && c.readonlyRootFilesystem)])
    error_message = "App containers run as the node user with a read-only root filesystem."
  }
  assert {
    condition     = !contains([for s in jsondecode(aws_ecs_task_definition.api.container_definitions)[0].secrets : s.name], "ADMIN_DATABASE_URL")
    error_message = "Only the release task gets the owner's database URL."
  }
  assert {
    condition     = contains([for s in jsondecode(aws_ecs_task_definition.release.container_definitions)[0].secrets : s.name], "ADMIN_DATABASE_URL")
    error_message = "The release task connects as the owner."
  }
  assert {
    condition     = length(aws_backup_plan.main.rule) == 2 && alltrue([for r in aws_backup_plan.main.rule : length(r.copy_action) == 1])
    error_message = "Daily and monthly backups, each copied to the recovery region."
  }
  assert {
    condition     = aws_ecr_repository.app["api"].image_tag_mutability == "IMMUTABLE"
    error_message = "Image tags are immutable."
  }
  assert {
    condition     = length(aws_cloudtrail.main) == 1 && aws_cloudtrail.main[0].is_multi_region_trail && aws_cloudtrail.main[0].enable_log_file_validation
    error_message = "CloudTrail records every region with log file validation."
  }
}

run "backup_account_copies" {
  command = apply
  variables {
    backup_account_vault_arn = "arn:aws:backup:us-east-1:333333333333:backup-vault:acct-backups"
  }
  assert {
    condition     = alltrue([for r in aws_backup_plan.main.rule : length(r.copy_action) == 2])
    error_message = "With a backup account, every backup is also copied there."
  }
  assert {
    condition     = strcontains(aws_kms_key.database.policy, "arn:aws:iam::333333333333:root")
    error_message = "The backup account can use the database key to copy snapshots."
  }
}

run "staging_is_smaller" {
  command = apply
  variables {
    environment         = "staging"
    single_nat_gateway  = true
    deletion_protection = false
  }
  assert {
    condition     = length(aws_nat_gateway.main) == 1
    error_message = "Staging shares one NAT gateway."
  }
  assert {
    condition     = jsondecode(aws_iam_role.deploy.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:example/accounting-platform:environment:staging"
    error_message = "Staging deploys come from the staging environment."
  }
}
