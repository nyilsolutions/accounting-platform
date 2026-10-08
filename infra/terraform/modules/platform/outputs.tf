output "app_url" {
  value = "https://${var.domain_name}"
}

output "load_balancer_dns_name" {
  description = "Point domain_name here (an alias or CNAME) when Route 53 doesn't host the zone."
  value       = aws_lb.main.dns_name
}

output "certificate_validation_records" {
  description = "DNS records that prove domain_name for the certificate (added automatically with route53_zone_id)."
  value       = [for o in aws_acm_certificate.app.domain_validation_options : { name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value }]
}

output "ses_dkim_tokens" {
  description = "CNAMEs <token>._domainkey.<mail_domain> -> <token>.dkim.amazonses.com (added automatically with route53_zone_id)."
  value       = aws_sesv2_email_identity.mail.dkim_signing_attributes[0].tokens
}

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.app : k => r.repository_url }
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "deploy_role_arn" {
  description = "AWS_DEPLOY_ROLE_ARN for the GitHub environment of the same name."
  value       = aws_iam_role.deploy.arn
}

output "release_network" {
  description = "Subnets and security group for running the release task (deploy workflow)."
  value = {
    subnets         = aws_subnet.app[*].id
    security_groups = [aws_security_group.tasks.id]
  }
}

output "task_families" {
  value = {
    api     = aws_ecs_task_definition.api.family
    worker  = aws_ecs_task_definition.worker.family
    web     = aws_ecs_task_definition.web.family
    release = aws_ecs_task_definition.release.family
  }
}

output "database_endpoint" {
  value = aws_db_instance.main.address
}

output "field_kms_key_arn" {
  value = aws_kms_key.field.arn
}

output "field_kms_replica_arn" {
  description = "FIELD_KMS_KEY_ID in the recovery region (disaster recovery runbook)."
  value       = aws_kms_replica_key.field_dr.arn
}

output "documents_bucket" {
  value = aws_s3_bucket.documents.bucket
}

output "documents_dr_bucket" {
  value = aws_s3_bucket.documents_dr.bucket
}

output "backup_vaults" {
  value = { primary = aws_backup_vault.main.arn, recovery_region = aws_backup_vault.dr.arn }
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}

output "provider_secrets" {
  description = "Secrets an operator fills in before the services start."
  value       = [for s in aws_secretsmanager_secret.provider : s.name]
}
