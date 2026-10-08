# Launch checklist

What has to be true before customers use production (ADR 0030). Code and Terraform do the
rest; this is what they can't. Work through it for staging first, then production. Tick each
item in the launch ticket with who did it and when.

## 1. Accounts and access

- [ ] Three AWS accounts in one AWS Organization: staging, production, backup.
- [ ] Cross-account backup turned on in the management account (AWS Backup > Settings).
- [ ] People sign in through IAM Identity Center with MFA. There are no IAM users with keys.
      Root users have MFA, and their credentials are locked away.
- [ ] Production access follows the access control policy: few people, reviewed quarterly.
- [ ] A billing alarm or budget on each account.

## 2. Terraform

- [ ] A state bucket in each account (`modules/state-backend`).
- [ ] `envs/backup` applied; its vault ARN is set as `backup_account_vault_arn` in production.
      The vault lock becomes permanent after 3 days, so check the retention limits first.
- [ ] `envs/staging` and `envs/production` applied, following `infra/terraform/README.md`
      (ECR first, push images, then everything).
- [ ] `terraform plan` shows no changes in either environment.
- [ ] Provider lock files committed (`terraform providers lock` for your platforms).

## 3. Domains, certificates and mail

- [ ] DNS for `domain_name` points at the load balancer. The ACM certificate is issued, which
      is automatic with `route53_zone_id`; otherwise use the `certificate_validation_records`
      output.
- [ ] SES: the mail domain is verified (DKIM CNAMEs, MAIL FROM MX and SPF, DMARC).
- [ ] **SES production access** requested and granted in each account. New accounts can only
      send to verified addresses.
- [ ] A test email (an invitation) arrives with DKIM and SPF passing and DMARC aligned. Check
      the headers.
- [ ] The DMARC record's `rua` reporting address is set, if reports are wanted.

## 4. Secrets and providers

- [ ] Every name in `provider_secret_names` has a value in Secrets Manager (`acct/<env>/<NAME>`).
      Staging uses sandbox credentials only.
- [ ] Providers turned on in `app_settings` only when their contracts and reviews are done:
  - [ ] Stripe Connect platform approved (ADR 0022).
  - [ ] Plaid production access (ADR 0011).
  - [ ] Intuit app approved for QuickBooks Online (ADR 0013).
  - [ ] Anthropic API key, if receipt reading by Claude is wanted (`DOCUMENT_AI=anthropic`).
- [ ] Payroll money movement and filing stay `none` until the real providers exist
      (EFTPS, deposit partner, e-file transmitter, state tax engine). Production refuses the
      stand-ins.
- [ ] `PAYROLL_TAX_ENGINE=none` unless a licensed engine is contracted (ADR 0026).

## 5. GitHub

- [ ] Environments `staging` and `production`, each with variables `AWS_DEPLOY_ROLE_ARN`
      (Terraform output `deploy_role_arn`), `AWS_ACCOUNT_ID` and `APP_URL`. Production also
      has `STAGING_ACCOUNT_ID`.
- [ ] `production` has required reviewers (not the person who merged), and deployments only
      from `main`.
- [ ] Branch protection on `main`: pull requests with review, the CI and Security checks
      required, no force pushes.
- [ ] The repository is mirrored or backed up outside GitHub (business continuity plan 3.5).

## 6. First deploy

- [ ] The deploy workflow ran green on staging and production. The release step's log shows
      `settings checked` and `created field key version 1`, then `field keys present` on
      later deploys.
- [ ] `https://<domain>/healthz` and `/api/health/ready` answer.
- [ ] The CSP and HSTS headers are present (`curl -sI https://<domain>/login`).
- [ ] A test company in staging: sign up, MFA, invoice, payment, a document upload (it scans
      clean), a report, a data export, an email.
- [ ] Rate limits see the real client IP: a sign-in failure's security event in the API log
      shows your address, not a 10.x one.

## 7. Monitoring

- [ ] `alarm_emails` confirmed their SNS subscriptions. Each alarm reaches a person, including
      out of hours (question 103).
- [ ] Each alarm tested once in staging: stop the API service, fill the error log, and so on.
- [ ] GuardDuty, CloudTrail and Access Analyzer show no open findings.
- [ ] Inspector shows no critical image findings without an accepted risk.

## 8. Backups and recovery

- [ ] The first AWS Backup jobs and copies succeeded: to us-west-2, and to the backup account
      in production.
- [ ] The first [restore drill](runbooks/restore-drill.md) passed on production, and its record
      is filed. The time to restore is compared with the RTO.
- [ ] Documents replicate: upload one and find it in the replica bucket.
- [ ] RPO, RTO, backup retention and log retention filled in the policies (question 100), and
      Terraform matches them (`daily_backup_retention_days`, `monthly_backup_retention_days`,
      `log_retention_days`).

## 9. Policies and people

- [ ] Policy placeholders filled in and approved (`docs/policies/README.md`).
- [ ] Vendors and subprocessors listed with their SOC reports: AWS, GitHub, and each
      provider turned on.
- [ ] The incident response plan's contacts reachable. A tabletop exercise held.
- [ ] Security awareness training done by everyone with production access.
- [ ] A penetration test of staging, with findings fixed or accepted (secure development
      policy).
- [ ] Privacy notice and terms of service published (outside this repository).

## 10. Product

- [ ] Open questions that block launch answered (`docs/open-questions.md`). The tax data's
      professional review is done (Phase 8).
- [ ] The seed demo data is not in production. `db:seed` is a development command and is
      never run there.
