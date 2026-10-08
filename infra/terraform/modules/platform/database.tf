# PostgreSQL 16 on RDS, Multi-AZ, encrypted, TLS only, in the data subnets (ADR 0030).
# The master user owns the schema and runs the release step; the app connects as acct_app,
# which the release step creates (CLAUDE.md rule 3).

resource "aws_db_subnet_group" "main" {
  name       = local.prefix
  subnet_ids = aws_subnet.data[*].id
  tags       = local.tags
}

resource "aws_security_group" "database" {
  name        = "${local.prefix}-database"
  description = "PostgreSQL, from the app tasks only"
  vpc_id      = aws_vpc.main.id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "database_from_tasks" {
  security_group_id            = aws_security_group.database.id
  description                  = "PostgreSQL from the API, worker and release tasks"
  referenced_security_group_id = aws_security_group.tasks.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_db_parameter_group" "main" {
  name   = "${local.prefix}-pg${var.db_engine_version}"
  family = "postgres${var.db_engine_version}"

  # TLS for every connection (the app also requires sslmode=verify-full in production).
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  # Slow statements are logged (with their text: the app never inlines values, ADR 0027).
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
  parameter {
    name  = "log_lock_waits"
    value = "1"
  }
  # Connections and sign-in failures are logged for investigations.
  parameter {
    name  = "log_connections"
    value = "1"
  }
  parameter {
    name  = "log_disconnections"
    value = "1"
  }
  # Statements that change roles or grants are logged (rds_superuser actions included).
  parameter {
    name  = "log_statement"
    value = "ddl"
  }
  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }
  tags = local.tags
}

# Passwords are generated on each run (ephemeral) and written straight to RDS and Secrets Manager
# through write-only attributes, applied when `db_passwords_version` changes: they never appear
# in the plan or the state.
ephemeral "random_password" "db_master" {
  length  = 40
  special = false
}

ephemeral "random_password" "db_app" {
  length  = 40
  special = false
}

resource "aws_db_instance" "main" {
  identifier     = local.prefix
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  db_name             = "acct"
  username            = "acct_owner"
  password_wo         = ephemeral.random_password.db_master.result
  password_wo_version = var.db_passwords_version

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.database.arn

  multi_az               = var.db_multi_az
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.database.id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.main.name
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  backup_retention_period   = var.db_backup_retention_days
  backup_window             = "07:00-08:00"
  maintenance_window        = "sun:08:30-sun:09:30"
  copy_tags_to_snapshot     = true
  delete_automated_backups  = false
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.prefix}-final"

  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false
  apply_immediately           = false

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.database.arn
  performance_insights_retention_period = 7
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.rds_monitoring.arn
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]

  tags = local.tags
}

# Point-in-time recovery in the recovery region too: automated backups and transaction logs are
# replicated there continuously (RPO of minutes even if the whole region is lost).
resource "aws_db_instance_automated_backups_replication" "dr" {
  provider               = aws.dr
  source_db_instance_arn = aws_db_instance.main.arn
  kms_key_id             = aws_kms_key.dr_backup.arn
  retention_period       = var.db_backup_retention_days
}

resource "aws_iam_role" "rds_monitoring" {
  name = "${local.prefix}-rds-monitoring"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_cloudwatch_log_group" "rds" {
  for_each          = toset(["postgresql", "upgrade"])
  name              = "/aws/rds/instance/${local.prefix}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.logs.arn
  tags              = local.tags
}
