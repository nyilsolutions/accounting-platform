# ECS on Fargate (ADR 0030): three services from three images, plus the release task.
#   web     - Next.js behind the load balancer; proxies /api to the API at api.<namespace>.
#   api     - the API with clamd (the clamd image) beside it (CLAMD_HOST=127.0.0.1); JOB_WORKER=off.
#   worker  - the same image running dist/worker.js (jobs and schedules), no clamd: files are
#             only scanned during uploads, which the API handles.
#   release - one-off per deploy: app role, migrations, job queue (dist/release.js).
# The deploy workflow registers new revisions of these task definitions with new images;
# Terraform ignores those changes (lifecycle below) so applies don't roll deploys back.

resource "aws_ecs_cluster" "main" {
  name = local.prefix
  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
  configuration {
    execute_command_configuration {
      kms_key_id = aws_kms_key.logs.arn
      logging    = "OVERRIDE"
      log_configuration {
        cloud_watch_encryption_enabled = true
        cloud_watch_log_group_name     = aws_cloudwatch_log_group.app["exec"].name
      }
    }
  }
  tags = local.tags
}

resource "aws_cloudwatch_log_group" "app" {
  for_each          = toset(["api", "worker", "web", "release", "clamd", "exec"])
  name              = "/${var.name}/${var.environment}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn
  tags              = local.tags
}

resource "aws_security_group" "tasks" {
  name        = "${local.prefix}-tasks"
  description = "API, worker and release tasks"
  vpc_id      = aws_vpc.main.id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "api_from_web" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "The API, from the web tasks"
  referenced_security_group_id = aws_security_group.web.id
  ip_protocol                  = "tcp"
  from_port                    = 4000
  to_port                      = 4000
}

resource "aws_vpc_security_group_egress_rule" "tasks_out" {
  security_group_id = aws_security_group.tasks.id
  description       = "HTTPS to AWS and providers, PostgreSQL, clamd signature updates"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "web" {
  name        = "${local.prefix}-web"
  description = "Web tasks, from the load balancer"
  vpc_id      = aws_vpc.main.id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "web_from_alb" {
  security_group_id            = aws_security_group.web.id
  description                  = "Next.js, from the load balancer"
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_vpc_security_group_egress_rule" "web_out" {
  security_group_id = aws_security_group.web.id
  description       = "The API and image pulls"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# The web tasks find the API by DNS (api.<name>.internal): Cloud Map keeps one record per
# healthy API task. No proxy in between, so the client IP the load balancer adds is the one
# the API sees (TRUST_PROXY below).
resource "aws_service_discovery_private_dns_namespace" "main" {
  name = "${var.name}.internal"
  vpc  = aws_vpc.main.id
  tags = local.tags
}

resource "aws_service_discovery_service" "api" {
  name = "api"
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.main.id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
  # Records follow the ECS task health checks.
  health_check_custom_config {}
  tags = local.tags
}

locals {
  files_origin = "https://${aws_s3_bucket.documents.bucket_regional_domain_name}"

  # Settings for every task of the API image. Providers default to none; app_settings turns
  # them on (with their credentials in provider_secret_names).
  app_environment = merge(
    {
      NODE_ENV      = "production"
      LOG_FORMAT    = "json"
      WEB_ORIGIN    = "https://${var.domain_name}"
      COOKIE_SECURE = "true"
      # Express trusts the hops inside the VPC (web tasks), so the client IP is the one the
      # load balancer appended to X-Forwarded-For (question 96).
      TRUST_PROXY           = "loopback, ${var.vpc_cidr}"
      DB_POOL_SIZE          = tostring(var.db_pool_size)
      FIELD_KEY_PROVIDER    = "aws-kms"
      FIELD_KMS_KEY_ID      = aws_kms_key.field.arn
      PASSWORD_BREACH_CHECK = "hibp"
      MAIL_TRANSPORT        = "ses"
      MAIL_FROM             = var.mail_from
      SES_CONFIGURATION_SET = aws_sesv2_configuration_set.main.configuration_set_name
      DOCUMENT_STORAGE      = "s3"
      S3_BUCKET             = aws_s3_bucket.documents.bucket
      S3_REGION             = local.region
      S3_SSE                = "aws:kms"
      S3_KMS_KEY_ID         = aws_kms_key.storage.arn
      VIRUS_SCANNER         = "clamd"
      CLAMD_HOST            = "127.0.0.1"
      JOB_QUEUE             = "pg-boss"
      BANK_FEED_PROVIDER    = "none"
      PAYMENTS_PROVIDER     = "none"
      QBO_ENVIRONMENT       = "none"
      EFILE_TRANSMITTER     = "none"
      EFTPS_BATCH_PROVIDER  = "none"
      DEPOSIT_PARTNER       = "none"
      PAYROLL_TAX_ENGINE    = "none"
      DOCUMENT_AI           = "heuristic"
      OTEL_SERVICE_NAME     = "${var.name}-api"
    },
    var.app_settings,
  )

  env_list    = { for k, v in local.app_environment : k => { name = k, value = v } }
  secret_list = { for k, v in local.app_secrets : k => { name = k, valueFrom = v } }

  log_options = {
    for k in ["api", "worker", "web", "release", "clamd"] : k => {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app[k].name
        awslogs-region        = local.region
        awslogs-stream-prefix = k
      }
    }
  }

  # Security settings shared by every container: no root, no writes to the image, no extra
  # Linux capabilities.
  hardening = {
    user                   = "1000"
    readonlyRootFilesystem = true
    linuxParameters        = { capabilities = { drop = ["ALL"] }, initProcessEnabled = true }
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 4096
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.app.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  volume {
    name = "tmp"
  }
  volume {
    name = "clamav-db"
  }
  volume {
    name = "clamd-tmp"
  }
  container_definitions = jsonencode([
    merge(local.hardening, {
      name         = "api"
      image        = var.api_image
      essential    = true
      portMappings = [{ containerPort = 4000, protocol = "tcp", name = "api" }]
      environment  = values(merge(local.env_list, { JOB_WORKER = { name = "JOB_WORKER", value = "off" } }))
      secrets      = values(local.secret_list)
      mountPoints  = [{ sourceVolume = "tmp", containerPath = "/tmp" }]
      healthCheck = {
        command     = ["CMD", "node", "-e", "fetch('http://127.0.0.1:4000/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
      dependsOn        = [{ containerName = "clamd", condition = "HEALTHY" }]
      stopTimeout      = 60
      logConfiguration = local.log_options["api"]
    }),
    merge(local.hardening, {
      # clamd and freshclam (docker/clamd); the API scans uploads through it on localhost:3310.
      name              = "clamd"
      image             = var.clamd_image
      user              = "999"
      essential         = true
      memoryReservation = 2048
      mountPoints = [
        { sourceVolume = "clamav-db", containerPath = "/var/lib/clamav" },
        { sourceVolume = "clamd-tmp", containerPath = "/tmp" },
      ]
      healthCheck = {
        command     = ["CMD", "clamdscan", "--ping=1"]
        interval    = 30
        timeout     = 10
        retries     = 5
        startPeriod = 300
      }
      logConfiguration = local.log_options["clamd"]
    }),
  ])
  tags = local.tags
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.prefix}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.app.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  volume {
    name = "tmp"
  }
  container_definitions = jsonencode([
    merge(local.hardening, {
      name             = "worker"
      image            = var.api_image
      essential        = true
      command          = ["node", "dist/worker.js"]
      environment      = values(merge(local.env_list, { OTEL_SERVICE_NAME = { name = "OTEL_SERVICE_NAME", value = "${var.name}-worker" } }))
      secrets          = values(local.secret_list)
      mountPoints      = [{ sourceVolume = "tmp", containerPath = "/tmp" }]
      stopTimeout      = 120
      logConfiguration = local.log_options["worker"]
    }),
  ])
  tags = local.tags
}

resource "aws_ecs_task_definition" "release" {
  family                   = "${local.prefix}-release"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.release.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([
    merge(local.hardening, {
      name             = "release"
      image            = var.api_image
      essential        = true
      command          = ["node", "dist/release.js"]
      environment      = values(local.env_list)
      secrets          = [for k, v in local.release_secrets : { name = k, valueFrom = v }]
      logConfiguration = local.log_options["release"]
    }),
  ])
  tags = local.tags
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.prefix}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.web.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  volume {
    name = "next-cache"
  }
  container_definitions = jsonencode([
    merge(local.hardening, {
      name         = "web"
      image        = var.web_image
      essential    = true
      portMappings = [{ containerPort = 3000, protocol = "tcp" }]
      environment  = [for k, v in merge({ FILES_ORIGIN = local.files_origin }, var.web_settings) : { name = k, value = v }]
      mountPoints  = [{ sourceVolume = "next-cache", containerPath = "/app/apps/web/.next/cache" }]
      healthCheck = {
        command     = ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
      stopTimeout      = 30
      logConfiguration = local.log_options["web"]
    }),
  ])
  tags = local.tags
}

resource "aws_ecs_service" "api" {
  name                               = "api"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.api.arn
  desired_count                      = var.api_count
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  enable_execute_command             = true
  propagate_tags                     = "SERVICE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.app[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }
  service_registries {
    registry_arn = aws_service_discovery_service.api.arn
  }
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
  tags = local.tags
}

resource "aws_ecs_service" "worker" {
  name                               = "worker"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.worker.arn
  desired_count                      = var.worker_count
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  enable_execute_command             = true
  propagate_tags                     = "SERVICE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.app[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }
  lifecycle {
    ignore_changes = [task_definition]
  }
  tags = local.tags
}

resource "aws_ecs_service" "web" {
  name                               = "web"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.web.arn
  desired_count                      = var.web_count
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  propagate_tags                     = "SERVICE"
  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.app[*].id
    security_groups  = [aws_security_group.web.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }
  lifecycle {
    ignore_changes = [task_definition]
  }
  depends_on = [aws_lb_listener.https]
  tags       = local.tags
}

# The API scales on CPU between api_count and api_max_count tasks.
resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_count
  max_capacity       = var.api_max_count
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.prefix}-api-cpu"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  policy_type        = "TargetTrackingScaling"
  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
