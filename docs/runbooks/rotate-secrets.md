# Rotate secrets

Yearly, when someone with access leaves, or at once if a secret may have leaked. All of these
are in Secrets Manager under `acct/<env>/`; Terraform generates the first four and never stores
them.

| Secret                                                                       | How                                                                                                                    |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Database passwords (`DATABASE_URL`, `ADMIN_DATABASE_URL`, `APP_DB_PASSWORD`) | Bump `db_passwords_version` and apply, then deploy (below)                                                             |
| `SIGNING_KEY`                                                                | Bump `signing_key_version`, apply, deploy. Download links (5 minutes) and QuickBooks sign-ins in progress stop working |
| `PASSWORD_PEPPER`                                                            | Never rotated: changing it would make every password fail. A leak of the pepper alone doesn't expose passwords         |
| Field keys                                                                   | `keys:rotate`, then `keys:reencrypt` (ADR 0029), run as one-off release tasks (below)                                  |
| Provider credentials (Stripe, Plaid, Intuit, ...)                            | Make a new one at the provider, put it in the secret, force a new deployment, then revoke the old one                  |

## Database passwords

Applying writes the new master password to RDS at once, and the new URLs to Secrets Manager.
Running tasks keep their open connections, but new connections need the new secrets:

1. `terraform apply` with the bumped `db_passwords_version`.
2. Run the deploy workflow with the current production tag (`image_tag`). Its release step
   sets the app role's new password from `APP_DB_PASSWORD`, and the services restart with the
   new `DATABASE_URL`.

There is a short window where restarting tasks may fail to connect. Do it at a quiet time.

## Field keys

```bash
# A one-off task of the release task definition (it has KMS rights and the owner's URL).
aws ecs run-task --cluster acct-production --task-definition acct-production-release \
  --launch-type FARGATE --network-configuration "$(aws ecs describe-services --cluster acct-production \
    --services api --query 'services[0].networkConfiguration' --output json)" \
  --overrides '{"containerOverrides":[{"name":"release","command":["node","dist/security/keys-cli.js","rotate"]}]}'
# Then restart the API and workers (force a new deployment of api and worker), then the same
# task with "reencrypt", then "status" to check every value is on the new version.
```

The KMS key itself rotates its key material yearly on its own; that needs nothing.
