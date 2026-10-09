#!/usr/bin/env bash
# Tests ecs-deploy.sh against a fake AWS CLI (no credentials, nothing deployed):
#   bash infra/deploy/test/ecs-deploy.test.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
deploy="$here/../ecs-deploy.sh"
failures=0

run() { # name, then env assignments; runs the deploy into a fresh fake
  export FAKE_AWS_DIR
  FAKE_AWS_DIR=$(mktemp -d)
  PATH="$here:$PATH" "$@" "$deploy" staging repo/api:new repo/web:new repo/clamd:new >"$FAKE_AWS_DIR/out" 2>&1
}
check() { # description, condition
  if eval "$2"; then echo "ok - $1"; else echo "not ok - $1"; failures=$((failures + 1)); fi
}

# 1. A good deploy.
run env && status=0 || status=$?
check "succeeds" "[ $status -eq 0 ]"
check "the API task gets the new API and clamd images" \
  "jq -e '.containerDefinitions == [{\"name\":\"api\",\"image\":\"repo/api:new\",\"environment\":[{\"name\":\"A\",\"value\":\"1\"}]},{\"name\":\"clamd\",\"image\":\"repo/clamd:new\"}]' \$FAKE_AWS_DIR/registered-acct-staging-api.json >/dev/null"
check "worker and release use the API image, web the web image" \
  "[ \"\$(jq -r '.containerDefinitions[0].image' \$FAKE_AWS_DIR/registered-acct-staging-worker.json)\" = repo/api:new ] && [ \"\$(jq -r '.containerDefinitions[0].image' \$FAKE_AWS_DIR/registered-acct-staging-release.json)\" = repo/api:new ] && [ \"\$(jq -r '.containerDefinitions[0].image' \$FAKE_AWS_DIR/registered-acct-staging-web.json)\" = repo/web:new ]"
check "read-only fields are not sent back to register-task-definition" \
  "! jq -e 'has(\"taskDefinitionArn\") or has(\"revision\") or has(\"status\") or has(\"registeredAt\") or has(\"requiresAttributes\") or has(\"compatibilities\")' \$FAKE_AWS_DIR/registered-acct-staging-api.json >/dev/null"
check "roles, sizes and volumes are kept" \
  "jq -e '.taskRoleArn == \"arn:aws:iam::1:role/app\" and .cpu == \"1024\" and .memory == \"4096\" and .volumes == [{\"name\":\"tmp\"}]' \$FAKE_AWS_DIR/registered-acct-staging-api.json >/dev/null"
check "the release step runs before any service is updated" \
  "[ \$(grep -n 'ecs run-task' \$FAKE_AWS_DIR/calls | cut -d: -f1) -lt \$(grep -n 'ecs update-service' \$FAKE_AWS_DIR/calls | head -1 | cut -d: -f1) ]"
check "the release task uses the new release revision and the API's network" \
  "grep -q 'run-task .*task-definition/acct-staging-release:8.*subnet-1' \$FAKE_AWS_DIR/calls"
check "all three services move to the new revisions" \
  "[ \$(grep -c 'ecs update-service' \$FAKE_AWS_DIR/calls) -eq 3 ] && grep -q 'update-service .*--service web --task-definition arn:aws:ecs:us-east-1:1:task-definition/acct-staging-web:8' \$FAKE_AWS_DIR/calls"

# 2. The release step fails: nothing is rolled out.
run env FAKE_RELEASE_EXIT=1 && status=0 || status=$?
check "a failed release step fails the deploy" "[ $status -ne 0 ]"
check "no service is updated after a failed release step" "! grep -q 'ecs update-service' \$FAKE_AWS_DIR/calls"
check "the release step's log is shown" "grep -q 'migration 0035 failed' \$FAKE_AWS_DIR/out"

# 3. ECS rolled a service back.
run env FAKE_ROLLED_BACK=web && status=0 || status=$?
check "a rolled-back service fails the deploy" "[ $status -ne 0 ] && grep -q 'web is on .*:7' \$FAKE_AWS_DIR/out"

if [ $failures -gt 0 ]; then
  echo "$failures failed"
  exit 1
fi
echo "all passed"
