#!/usr/bin/env bash
# The quarterly restore drill (business continuity plan, section 4; runbook
# docs/runbooks/restore-drill.md). Run by an operator with administrator access to the
# environment's account:
#
#   restore-drill.sh <environment> [<restore time, e.g. 2026-10-08T06:00:00Z>]
#
# 1. Restores the database to a point in time (default: the latest restorable time) as a new,
#    private instance in the data subnets, and times it.
# 2. Runs the restore checks (`dist/ops/verify-restore-cli.js`) as a one-off task of the
#    release task definition, pointed at the copy: migrations, balanced books, field keys
#    decrypt, documents read back with their checksums.
# 3. Deletes the copy (it holds customer data), unless KEEP=1.
# Prints a summary to paste into the drill record.
set -euo pipefail

env_name=${1:?environment}
restore_time=${2:-}
prefix="${APP_PREFIX:-acct}-${env_name}"
drill_id="$prefix-drill-$(date -u +%Y%m%d%H%M)"
log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }

source_db=$(aws rds describe-db-instances --db-instance-identifier "$prefix" --query 'DBInstances[0]' --output json)
subnet_group=$(jq -r '.DBSubnetGroup.DBSubnetGroupName' <<<"$source_db")
security_groups=$(jq -r '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(" ")' <<<"$source_db")
parameter_group=$(jq -r '.DBParameterGroups[0].DBParameterGroupName' <<<"$source_db")
instance_class=$(jq -r '.DBInstanceClass' <<<"$source_db")

if [ -n "$restore_time" ]; then
  point=(--restore-time "$restore_time")
else
  restore_time=$(jq -r '.LatestRestorableTime' <<<"$source_db")
  point=(--use-latest-restorable-time)
fi

cleanup() {
  if [ "${KEEP:-0}" = 1 ]; then
    log "KEEP=1: $drill_id is left running; delete it when done (it holds customer data)"
    return
  fi
  log "deleting $drill_id"
  aws rds delete-db-instance --db-instance-identifier "$drill_id" \
    --skip-final-snapshot --delete-automated-backups >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "restoring $prefix to $restore_time as $drill_id"
started=$(date +%s)
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "$prefix" \
  --target-db-instance-identifier "$drill_id" \
  "${point[@]}" \
  --db-subnet-group-name "$subnet_group" \
  --vpc-security-group-ids $security_groups \
  --db-parameter-group-name "$parameter_group" \
  --db-instance-class "$instance_class" \
  --no-multi-az --no-publicly-accessible --no-deletion-protection \
  --tags Key=Purpose,Value=restore-drill >/dev/null
aws rds wait db-instance-available --db-instance-identifier "$drill_id"
restored=$(date +%s)
host=$(aws rds describe-db-instances --db-instance-identifier "$drill_id" \
  --query 'DBInstances[0].Endpoint.Address' --output text)
log "restored in $(((restored - started) / 60)) minutes: $host"

network=$(aws ecs describe-services --cluster "$prefix" --services api \
  --query 'services[0].networkConfiguration' --output json)
overrides=$(jq -nc --arg host "$host" '{containerOverrides: [{
  name: "release",
  command: ["node", "dist/ops/verify-restore-cli.js"],
  environment: [{name: "DRILL_DB_HOST", value: $host}]
}]}')
log "running the restore checks"
task=$(aws ecs run-task --cluster "$prefix" --task-definition "$prefix-release" \
  --launch-type FARGATE --count 1 --network-configuration "$network" \
  --overrides "$overrides" --started-by restore-drill \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster "$prefix" --tasks "$task"
verified=$(date +%s)
exit_code=$(aws ecs describe-tasks --cluster "$prefix" --tasks "$task" \
  --query 'tasks[0].containers[?name==`release`].exitCode | [0]' --output text)
report=$(aws logs get-log-events --log-group-name "/${APP_PREFIX:-acct}/$env_name/release" \
  --log-stream-name "release/release/${task##*/}" \
  --query 'events[].message' --output text | grep -o '{"drillReport".*' | tail -1 || true)

result=$([ "$exit_code" = 0 ] && echo PASSED || echo FAILED)
cat <<SUMMARY
Restore drill: $env_name, $(date -u +%Y-%m-%d)
- Restored to:          $restore_time
- Newest change found:  $(jq -r '.drillReport.newestChange // "unknown"' <<<"${report:-{\}}")
- Time to restore:      $(((restored - started) / 60)) minutes (compare with the RTO)
- Time to verify:       $(((verified - restored) / 60)) minutes
- Result:               $result
$(jq -r '.drillReport.checks[]? | "- \(.name): \(if .ok then "ok" else "FAILED" end), \(.detail)"' <<<"${report:-{\}}")
$(jq -r '.drillReport.counts // {} | to_entries[] | "- \(.key): \(.value)"' <<<"${report:-{\}}")
SUMMARY
[ "$result" = PASSED ]
