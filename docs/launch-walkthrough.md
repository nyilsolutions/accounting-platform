# Launch walkthrough

The order to work through the [launch checklist](launch-checklist.md), with the commands to run.
It starts from no AWS accounts and no domain. You run the commands with your own AWS sign-in;
nothing here stores AWS keys in the repository or in CI. Paste back any error and the outputs
each step asks for.

**You need:** the AWS CLI v2, Terraform 1.11 or later, Docker with buildx, git, and a clone of
this repository on `main`. Every `terraform` command below runs in the directory named in its
step.

**Names used below:** `example.com` stands for the domain you register in step 3. The app is
`books.example.com`, staging is `books.staging.example.com`, and mail goes from
`mail.example.com` and `mail.staging.example.com`. Use your own names throughout.

## 1. The management account and IAM Identity Center

1. Create a new AWS account at aws.amazon.com. It becomes the organization's **management
   account**: billing and the organization only, no workloads. Use an email address that
   several people can reach (for example `aws@example.com`).
2. Sign in as the root user. Turn on MFA for the root user (IAM > Security credentials). From
   now on the root user is only for emergencies.
3. Turn on **IAM Identity Center**: console > IAM Identity Center > Enable, choose an
   organization instance, in **us-east-1**. This creates the AWS Organization too.
4. Bootstrap your own access to the management account (Terraform creates everyone else's):
   - Identity Center > Users > Add user: you, with your email. Accept the invitation and
     register an MFA device.
   - Identity Center > Permission sets > Create: predefined `AdministratorAccess`, named
     `ManagementAdmin`, session duration 1 hour.
   - Identity Center > AWS accounts > the management account > Assign: you, `ManagementAdmin`.
5. Configure the CLI: `aws configure sso`. Use the AWS access portal URL from Identity Center >
   Settings, the management account, `ManagementAdmin`, region `us-east-1`, profile name
   `acct-management`. Then check it works:
   ```bash
   aws sso login --profile acct-management
   aws sts get-caller-identity --profile acct-management   # note the Account: the management account id
   ```

## 2. The organization, accounts and guardrails (`envs/organization`)

This creates:

- the staging, production and backup accounts, under Staging, Production and Security OUs;
- service control policies:
  - no leaving the organization;
  - no root user in member accounts;
  - only us-east-1 and us-west-2;
  - in production and backup, no turning off CloudTrail or GuardDuty, and no deleting keys,
    vaults, backups or buckets;
- cross-account backup;
- a monthly budget per account;
- the `acct-admins` and `acct-readonly` groups with access to all three accounts.

```bash
export AWS_PROFILE=acct-management

# The management account's Terraform state bucket (local state for this one bucket).
cd infra/terraform/modules/state-backend
terraform init
terraform apply -var bucket_name=acct-management-terraform-state-<management account id>
mkdir -p ../../state-bootstrap/management && mv terraform.tfstate ../../state-bootstrap/management/
cd -

cd infra/terraform/envs/organization
cp terraform.tfvars.example terraform.tfvars   # fill in: account id, three account emails, people, budget emails
cp backend.hcl.example backend.hcl             # the bucket just created
terraform init -backend-config=backend.hcl
terraform test                                 # offline, against mocked AWS
# Turning on Identity Center created the organization: Terraform takes it over.
terraform import aws_organizations_organization.main "$(aws organizations describe-organization --query Organization.Id --output text)"
terraform apply
terraform output account_ids                   # paste these back
```

Each account needs its own root email. Plus-addressing works (`aws+staging@example.com`).
Account creation takes a few minutes per account.

Then:

- Everyone in `people` accepts the Identity Center invitation and registers MFA.
- Add CLI profiles with `aws configure sso`, the `AcctAdministrator` permission set and region
  `us-east-1`: `acct-staging`, `acct-production` and `acct-backup`, one per account.
- Turn on centralized root access for the member accounts: IAM > Root access management >
  Enable, in the management account. The member accounts then have no root credentials at
  all, and the service control policy blocks root use too.

## 3. The domain (open question 102)

Register the domain in the **production** account: `AWS_PROFILE=acct-production`, console >
Route 53 > Registered domains > Register. Route 53 creates its hosted zone. Note the **hosted
zone id** (Route 53 > Hosted zones), because production's `route53_zone_id` uses it.

Registration can take up to a day. Steps 4 and 5 don't need the domain yet.

## 4. State buckets and the backup account

```bash
for env in staging production backup; do
  ( export AWS_PROFILE=acct-$env
    id=$(aws sts get-caller-identity --query Account --output text)
    cd infra/terraform/modules/state-backend
    rm -rf .terraform                           # each account's bucket gets its own local state
    terraform init -input=false
    terraform apply -var bucket_name=acct-$env-terraform-state-$id
    mkdir -p ../../state-bootstrap/$env && mv terraform.tfstate ../../state-bootstrap/$env/ )
done
```

`infra/terraform/state-bootstrap/` keeps each bucket's local state file. Git ignores it. The
files hold only the bucket definitions; keep them somewhere safe.

The backup account's locked vault:

```bash
export AWS_PROFILE=acct-backup
cd infra/terraform/envs/backup
cp terraform.tfvars.example terraform.tfvars   # account_id = backup; source_account_ids = [production]
cp backend.hcl.example backend.hcl             # bucket acct-backup-terraform-state-<backup id>
terraform init -backend-config=backend.hcl
terraform apply
terraform output vault_arn                     # for production's backup_account_vault_arn
```

The vault lock can be removed for 3 days, then it is permanent. Its default limits are copies
kept between 7 days and 7 years. Check them against the backup retention you want before the
3 days are up (open question 100).

## 5. Staging (`envs/staging`)

```bash
export AWS_PROFILE=acct-staging
cd infra/terraform/envs/staging
cp terraform.tfvars.example terraform.tfvars
cp backend.hcl.example backend.hcl             # bucket acct-staging-terraform-state-<staging id>
terraform init -backend-config=backend.hcl
```

In `terraform.tfvars`, set:

- `account_id` and `production_account_id`;
- `dns_zone_name = "staging.example.com"` (leave `route53_zone_id` out);
- `domain_name`, `mail_domain` and `mail_from`;
- `alarm_emails`;
- for now, `api_image` and `web_image` set to `"pending"`.

The steps, in order:

1. **Staging's DNS zone**, then its name servers for production:
   ```bash
   terraform apply -target=aws_route53_zone.staging
   terraform output dns_name_servers
   ```
2. **Delegate the subdomain from production's zone** (once the domain is registered). Run this
   in `envs/production` with `AWS_PROFILE=acct-production`, after its `init` and
   `terraform.tfvars` (as in step 6, with `api_image` and `web_image` still `"pending"`):
   ```bash
   # in production's terraform.tfvars:
   #   route53_zone_id    = "<the domain's hosted zone id>"
   #   staging_delegation = { name = "staging.example.com", name_servers = [<the four above>] }
   terraform apply -target=aws_route53_record.staging_delegation
   ```
3. **The image repositories, then the first images** (back in `envs/staging`, with
   `AWS_PROFILE=acct-staging`):
   ```bash
   terraform apply -target=module.platform.aws_ecr_repository.app
   cd ../../../..
   AWS_PROFILE=acct-staging infra/bootstrap/push-images.sh <staging account id>
   ```
   Put the two printed image URIs in `terraform.tfvars` as `api_image` and `web_image`.
4. **Everything else:**
   ```bash
   cd infra/terraform/envs/staging
   terraform apply
   ```
   This takes 20 to 40 minutes, mostly the database. When it's done:
   - confirm the alarm topic subscription email;
   - request **SES production access**: console > SES > Account dashboard > Request
     production access, transactional mail.
5. **Paste back** `terraform output -json platform`. It has the GitHub values for step 7.

## 6. Production (`envs/production`)

```bash
export AWS_PROFILE=acct-production
cd infra/terraform/envs/production
cp terraform.tfvars.example terraform.tfvars
cp backend.hcl.example backend.hcl             # bucket acct-production-terraform-state-<production id>
terraform init -backend-config=backend.hcl
```

In `terraform.tfvars`, set:

- `account_id` and `staging_account_id`;
- `route53_zone_id`, `staging_delegation` (from step 5), `domain_name`, `mail_domain`,
  `mail_from` and `alarm_emails`;
- `backup_account_vault_arn`, from step 4.

The image repositories, then the same images staging runs, copied by digest:

```bash
terraform apply -target=module.platform.aws_ecr_repository.app
aws ecr get-login-password --profile acct-staging | docker login -u AWS --password-stdin <staging id>.dkr.ecr.us-east-1.amazonaws.com
aws ecr get-login-password --profile acct-production | docker login -u AWS --password-stdin <production id>.dkr.ecr.us-east-1.amazonaws.com
for repo in api web; do
  docker buildx imagetools create \
    --tag <production id>.dkr.ecr.us-east-1.amazonaws.com/acct/$repo:<tag> \
    <staging id>.dkr.ecr.us-east-1.amazonaws.com/acct/$repo:<tag>
done
```

Set `api_image` and `web_image` to the production URIs, run `terraform apply`, then request
SES production access in this account too.

## 7. GitHub

These are settings in the GitHub repository; nothing to run.

1. **Environments** (Settings > Environments): `staging` and `production`.
   - Each gets the variables `AWS_DEPLOY_ROLE_ARN` (output `deploy_role_arn`),
     `AWS_ACCOUNT_ID` and `APP_URL` (`https://books.staging.example.com` or
     `https://books.example.com`).
   - Production also gets `STAGING_ACCOUNT_ID`.
   - On `production`: required reviewers, and deployment branches limited to `main`.
2. **Branch protection on `main`** (Settings > Branches): pull requests with one review, the
   `ci`, `images`, `terraform` and Security checks required, no force pushes.
3. **Turn deploys on:** Settings > Secrets and variables > Actions > Variables >
   `DEPLOY_ENABLED` = `true`.

## 8. The first deploy

Run the workflow: Actions > Deploy > Run workflow, on `main`, with no image tag. It then:

1. builds the images;
2. deploys staging, where the release step's log should show `settings checked` and
   `created field key version 1`;
3. waits for your approval;
4. deploys production.

Then check:

```bash
curl -sS https://books.staging.example.com/healthz
curl -sS https://books.staging.example.com/api/health/ready
curl -sI https://books.staging.example.com/login | grep -i -E 'content-security-policy|strict-transport'
```

Also run the staging test company from checklist section 6: sign up, MFA, an invoice, an upload,
a report and an export.

## 9. Backups, monitoring and the first restore drill

- The next day: AWS Backup > Jobs in production, where the backup and its copies (to us-west-2
  and to the backup account) succeeded.
- Upload a document in production and find it in the `-documents-dr-` bucket in us-west-2.
- Test an alarm in staging: stop the API service for 5 minutes and check the email arrives.
- Run the first [restore drill](runbooks/restore-drill.md) on production and file its record.

## 10. What's left

These are the remaining sections of the [launch checklist](launch-checklist.md):

- the policies' placeholders and approvals;
- vendors;
- a penetration test of staging;
- the incident tabletop;
- turning on the providers you have contracts for;
- the open questions that block launch (`docs/open-questions.md`, especially 100 to 108).
