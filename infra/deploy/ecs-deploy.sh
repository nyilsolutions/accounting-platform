#!/usr/bin/env bash
# Deploys one commit's images to one environment (ADR 0030), run by .github/workflows/deploy.yml
# with that environment's AWS role:
#   1. registers new revisions of the release, api, worker and web task definitions with the
#      new images (everything else stays as Terraform made it);
#   2. runs the release step (app role, migrations, job queue) and stops if it fails;
#   3. rolls the services onto the new revisions and waits until they are stable (ECS rolls
#      a service back by itself if its new tasks don't become healthy);
#   4. checks the site answers.
#
#   ecs-deploy.sh <environment> <api image> <web image> <clamd image> [<app url>]
#
# Migrations run before the new code and must work with the code already running (expand,
# then contract in a later release: docs/runbooks/deploy.md).
set -euo pipefail

env_name=${1:?environment}
api_image=${2:?api image}
web_image=${3:?web image}
clamd_image=${4:?clamd image}
app_url=${5:-}
prefix="${APP_PREFIX:-acct}-${env_name}"
cluster="$prefix"

log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }

# Registers a copy of the family's latest revision with new images; prints the new ARN.
# $1 family, then pairs of <container name> <image>.
register() {
  local family=$1
  shift
  local current
  current=$(aws ecs describe-task-definition --task-definition "$family" --query taskDefinition --output json)
  local images='{}'
  while [ $# -gt 0 ]; do
    images=$(jq -c --arg n "$1" --arg i "$2" '. + {($n): $i}' <<<"$images")
    shift 2
  done
  jq --argjson images "$images" '
    .containerDefinitions |= map(if $images[.name] then .image = $images[.name] else . end)
    | {family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions, volumes,
       placementConstraints, requiresCompatibilities, cpu, memory, runtimePlatform,
       ephemeralStorage}
    | with_entries(select(.value != null))' <<<"$current" >"$work/$family.json"
  aws ecs register-task-definition --cli-input-json "file://$work/$family.json" \
    --query taskDefinition.taskDefinitionArn --output text
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

log "registering task definitions for $env_name"
release_td=$(register "$prefix-release" release "$api_image")
api_td=$(register "$prefix-api" api "$api_image" clamd "$clamd_image")
worker_td=$(register "$prefix-worker" worker "$api_image")
web_td=$(register "$prefix-web" web "$web_image")

# The release task runs in the API service's subnets and security group.
network=$(aws ecs describe-services --cluster "$cluster" --services api \
  --query 'services[0].networkConfiguration' --output json)

log "running the release step"
task=$(aws ecs run-task --cluster "$cluster" --task-definition "$release_td" \
  --launch-type FARGATE --count 1 --network-configuration "$network" \
  --started-by "deploy-${GITHUB_RUN_ID:-manual}" \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task"
result=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$task" --query 'tasks[0]' --output json)
exit_code=$(jq -r '(.containers[] | select(.name == "release") | .exitCode) // "none"' <<<"$result")
if [ "$exit_code" != "0" ]; then
  log "release step failed (exit $exit_code): $(jq -r '.stoppedReason // ""' <<<"$result")"
  aws logs get-log-events --log-group-name "/${APP_PREFIX:-acct}/$env_name/release" \
    --log-stream-name "release/release/${task##*/}" --limit 50 \
    --query 'events[].message' --output text || true
  exit 1
fi
log "release step done"

for pair in "api:$api_td" "worker:$worker_td" "web:$web_td"; do
  service=${pair%%:*}
  log "updating $service"
  aws ecs update-service --cluster "$cluster" --service "$service" \
    --task-definition "${pair#*:}" --query 'service.serviceName' --output text >/dev/null
done

log "waiting for the services to become stable"
if ! aws ecs wait services-stable --cluster "$cluster" --services api worker web; then
  aws ecs describe-services --cluster "$cluster" --services api worker web \
    --query 'services[].{service:serviceName,rollout:deployments[0].rolloutState,reason:deployments[0].rolloutStateReason}' \
    --output table || true
  log "the services did not become stable (ECS rolls back a failed deployment)"
  exit 1
fi
for service in api worker web; do
  state=$(aws ecs describe-services --cluster "$cluster" --services "$service" \
    --query 'services[0].deployments[0].rolloutState' --output text)
  td=$(aws ecs describe-services --cluster "$cluster" --services "$service" \
    --query 'services[0].taskDefinition' --output text)
  case "$service" in api) want=$api_td ;; worker) want=$worker_td ;; web) want=$web_td ;; esac
  if [ "$state" != "COMPLETED" ] || [ "$td" != "$want" ]; then
    log "$service is on $td ($state), not the new revision: it was rolled back"
    exit 1
  fi
done

if [ -n "$app_url" ]; then
  log "checking $app_url"
  for path in /healthz /api/health/ready; do
    ok=no
    for _ in $(seq 1 10); do
      if curl -fsS --max-time 10 "$app_url$path" >/dev/null; then ok=yes && break; fi
      sleep 6
    done
    [ "$ok" = yes ] || { log "$app_url$path is not answering"; exit 1; }
  done
fi
log "deployed $api_image, $web_image and $clamd_image to $env_name"
