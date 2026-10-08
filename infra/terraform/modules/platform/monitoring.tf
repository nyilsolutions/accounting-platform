# Alerting (logging and monitoring policy): every alarm goes to one encrypted SNS topic, which
# emails alarm_emails (add a pager subscription the same way). The runbooks in docs/runbooks/
# say what to do for each alarm, by name.

resource "aws_sns_topic" "alarms" {
  name              = "${local.prefix}-alarms"
  kms_master_key_id = aws_kms_key.logs.arn
  tags              = local.tags
}

resource "aws_sns_topic_policy" "alarms" {
  arn = aws_sns_topic.alarms.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AwsServicesPublish"
      Effect    = "Allow"
      Principal = { Service = ["cloudwatch.amazonaws.com", "events.amazonaws.com", "backup.amazonaws.com", "events.rds.amazonaws.com"] }
      Action    = "sns:Publish"
      Resource  = aws_sns_topic.alarms.arn
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
}

resource "aws_sns_topic_subscription" "alarm_emails" {
  for_each  = toset(var.alarm_emails)
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = each.key
}

# SES bounces and complaints, for the mail runbook (not paged; the rates are alarmed below).
resource "aws_sns_topic" "mail_events" {
  name              = "${local.prefix}-mail-events"
  kms_master_key_id = aws_kms_key.logs.arn
  tags              = local.tags
}

resource "aws_sns_topic_policy" "mail_events" {
  arn = aws_sns_topic.mail_events.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "SesPublishes"
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "sns:Publish"
      Resource  = aws_sns_topic.mail_events.arn
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
}

locals {
  alarm_actions = [aws_sns_topic.alarms.arn]
  alb_dimension = { LoadBalancer = aws_lb.main.arn_suffix }

  # name => [namespace, metric, statistic, dimensions, comparison, threshold, periods, description]
  metric_alarms = {
    "web-5xx" = {
      namespace   = "AWS/ApplicationELB", metric = "HTTPCode_Target_5XX_Count", statistic = "Sum"
      dimensions  = local.alb_dimension, comparison = "GreaterThanThreshold", threshold = 10, periods = 5
      description = "More than 10 server errors a minute for 5 minutes (runbook: high-error-rate)."
    }
    "alb-5xx" = {
      namespace   = "AWS/ApplicationELB", metric = "HTTPCode_ELB_5XX_Count", statistic = "Sum"
      dimensions  = local.alb_dimension, comparison = "GreaterThanThreshold", threshold = 10, periods = 5
      description = "The load balancer itself is answering 5xx: no healthy web tasks? (runbook: service-down)."
    }
    "web-unhealthy" = {
      namespace   = "AWS/ApplicationELB", metric = "UnHealthyHostCount", statistic = "Maximum"
      dimensions  = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.web.arn_suffix }
      comparison  = "GreaterThanThreshold", threshold = 0, periods = 5
      description = "A web task is failing its health check (runbook: service-down)."
    }
    "db-cpu" = {
      namespace   = "AWS/RDS", metric = "CPUUtilization", statistic = "Average"
      dimensions  = { DBInstanceIdentifier = aws_db_instance.main.identifier }
      comparison  = "GreaterThanThreshold", threshold = 80, periods = 10
      description = "Database CPU above 80% for 10 minutes (runbook: database)."
    }
    "db-storage" = {
      namespace   = "AWS/RDS", metric = "FreeStorageSpace", statistic = "Minimum"
      dimensions  = { DBInstanceIdentifier = aws_db_instance.main.identifier }
      comparison  = "LessThanThreshold", threshold = 10 * 1024 * 1024 * 1024, periods = 5
      description = "Less than 10 GiB of database storage left (runbook: database)."
    }
    "db-memory" = {
      namespace   = "AWS/RDS", metric = "FreeableMemory", statistic = "Minimum"
      dimensions  = { DBInstanceIdentifier = aws_db_instance.main.identifier }
      comparison  = "LessThanThreshold", threshold = 256 * 1024 * 1024, periods = 10
      description = "Less than 256 MiB of free database memory (runbook: database)."
    }
    "db-connections" = {
      namespace   = "AWS/RDS", metric = "DatabaseConnections", statistic = "Maximum"
      dimensions  = { DBInstanceIdentifier = aws_db_instance.main.identifier }
      comparison  = "GreaterThanThreshold", threshold = 300, periods = 5
      description = "Unusually many database connections (runbook: database)."
    }
    "api-cpu" = {
      namespace   = "AWS/ECS", metric = "CPUUtilization", statistic = "Average"
      dimensions  = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.api.name }
      comparison  = "GreaterThanThreshold", threshold = 85, periods = 10
      description = "API CPU above 85% for 10 minutes even with scaling (runbook: high-latency)."
    }
    "api-memory" = {
      namespace   = "AWS/ECS", metric = "MemoryUtilization", statistic = "Maximum"
      dimensions  = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.api.name }
      comparison  = "GreaterThanThreshold", threshold = 90, periods = 5
      description = "API task memory above 90% (runbook: high-latency)."
    }
    "ses-bounces" = {
      namespace   = "AWS/SES", metric = "Reputation.BounceRate", statistic = "Maximum"
      dimensions  = {}, comparison = "GreaterThanThreshold", threshold = 0.04, periods = 1
      description = "SES bounce rate above 4% (SES reviews accounts at 5%; runbook: mail)."
    }
    "ses-complaints" = {
      namespace   = "AWS/SES", metric = "Reputation.ComplaintRate", statistic = "Maximum"
      dimensions  = {}, comparison = "GreaterThanThreshold", threshold = 0.0008, periods = 1
      description = "SES complaint rate above 0.08% (SES reviews accounts at 0.1%; runbook: mail)."
    }
    "s3-replication" = {
      namespace   = "AWS/S3", metric = "OperationsFailedReplication", statistic = "Sum"
      dimensions  = { SourceBucket = aws_s3_bucket.documents.bucket, DestinationBucket = aws_s3_bucket.documents_dr.bucket, RuleId = "to-recovery-region" }
      comparison  = "GreaterThanThreshold", threshold = 0, periods = 1
      description = "Documents failed to replicate to the recovery region (runbook: backups)."
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "metric" {
  for_each            = local.metric_alarms
  alarm_name          = "${local.prefix}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  statistic           = each.value.statistic
  dimensions          = each.value.dimensions
  comparison_operator = each.value.comparison
  threshold           = each.value.threshold
  period              = 60
  evaluation_periods  = each.value.periods
  datapoints_to_alarm = each.value.periods
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  tags                = local.tags
}

# p95 response time over the 2-second target (ADR 0028), measured at the load balancer.
resource "aws_cloudwatch_metric_alarm" "latency" {
  alarm_name          = "${local.prefix}-latency-p95"
  alarm_description   = "p95 response time above 2 s for 10 minutes (runbook: high-latency)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  dimensions          = local.alb_dimension
  comparison_operator = "GreaterThanThreshold"
  threshold           = 2
  period              = 60
  evaluation_periods  = 10
  datapoints_to_alarm = 8
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  tags                = local.tags
}

# Fewer running tasks than wanted for 5 minutes (crash loops, failed deploys, capacity).
resource "aws_cloudwatch_metric_alarm" "running_tasks" {
  for_each            = { api = var.api_count, worker = var.worker_count, web = var.web_count }
  alarm_name          = "${local.prefix}-${each.key}-tasks"
  alarm_description   = "The ${each.key} service has fewer running tasks than it should (runbook: service-down)."
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  statistic           = "Minimum"
  dimensions          = { ClusterName = aws_ecs_cluster.main.name, ServiceName = each.key }
  comparison_operator = "LessThanThreshold"
  threshold           = each.value
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  tags                = local.tags
}

# --- From the JSON logs ------------------------------------------------------------------------

locals {
  log_alarms = {
    # Errors logged by the API or worker (failed jobs log at error level too, ADR 0027).
    "api-errors"    = { group = "api", pattern = "{ $.level = \"error\" }", threshold = 20, description = "More than 20 errors logged by the API in 5 minutes (runbook: high-error-rate)." }
    "worker-errors" = { group = "worker", pattern = "{ $.level = \"error\" }", threshold = 20, description = "More than 20 errors logged by the worker in 5 minutes: failing jobs (runbook: jobs)." }
    # Refused or suspicious requests (securityEvent, ADR 0029): a spike may be an attack.
    "security-events" = { group = "api", pattern = "{ $.context = \"Security\" }", threshold = 200, description = "More than 200 security events in 5 minutes (runbook: security-events)." }
    # The release step failed (it logs `release failed`).
    "release-failed" = { group = "release", pattern = "\"release failed\"", threshold = 0, description = "A deploy's release step failed (runbook: deploy)." }
  }
}

resource "aws_cloudwatch_log_metric_filter" "app" {
  for_each       = local.log_alarms
  name           = "${local.prefix}-${each.key}"
  log_group_name = aws_cloudwatch_log_group.app[each.value.group].name
  pattern        = each.value.pattern
  metric_transformation {
    name          = each.key
    namespace     = "${var.name}/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "logs" {
  for_each            = local.log_alarms
  alarm_name          = "${local.prefix}-${each.key}"
  alarm_description   = each.value.description
  namespace           = "${var.name}/${var.environment}"
  metric_name         = each.key
  statistic           = "Sum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = each.value.threshold
  period              = 300
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  tags                = local.tags
  depends_on          = [aws_cloudwatch_log_metric_filter.app]
}

# --- Events -------------------------------------------------------------------------------------

# Database failovers, failures, low storage and maintenance.
resource "aws_db_event_subscription" "main" {
  name             = local.prefix
  sns_topic        = aws_sns_topic.alarms.arn
  source_type      = "db-instance"
  source_ids       = [aws_db_instance.main.identifier]
  event_categories = ["availability", "failover", "failure", "low storage", "maintenance", "recovery"]
  tags             = local.tags
}

# A task that stopped because it crashed or failed its health check.
resource "aws_cloudwatch_event_rule" "task_stopped" {
  name        = "${local.prefix}-task-stopped"
  description = "ECS tasks that stopped unexpectedly"
  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Task State Change"]
    detail = {
      clusterArn = [aws_ecs_cluster.main.arn]
      lastStatus = ["STOPPED"]
      # The release task exits when it is done; its failures are alarmed from its log.
      group    = [{ anything-but = ["family:${local.prefix}-release"] }]
      stopCode = ["TaskFailedToStart", "EssentialContainerExited"]
    }
  })
  tags = local.tags
}

resource "aws_cloudwatch_event_target" "task_stopped" {
  rule      = aws_cloudwatch_event_rule.task_stopped.name
  target_id = "alarms"
  arn       = aws_sns_topic.alarms.arn
}

# GuardDuty findings of medium severity or worse.
resource "aws_cloudwatch_event_rule" "guardduty" {
  count       = var.enable_account_security ? 1 : 0
  name        = "${local.prefix}-guardduty"
  description = "GuardDuty findings, severity 4 and up"
  event_pattern = jsonencode({
    source      = ["aws.guardduty"]
    detail-type = ["GuardDuty Finding"]
    detail      = { severity = [{ numeric = [">=", 4] }] }
  })
  tags = local.tags
}

resource "aws_cloudwatch_event_target" "guardduty" {
  count     = var.enable_account_security ? 1 : 0
  rule      = aws_cloudwatch_event_rule.guardduty[0].name
  target_id = "alarms"
  arn       = aws_sns_topic.alarms.arn
}
