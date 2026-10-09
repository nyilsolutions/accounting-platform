#!/usr/bin/env bash
# The first images for a new environment (docs/launch-walkthrough.md). Terraform's first full
# apply needs images in the environment's ECR; after that the Deploy workflow builds and pushes
# them. Run from the repository root with the environment's AWS profile:
#
#   AWS_PROFILE=acct-staging infra/bootstrap/push-images.sh <account id>
#
# Builds the api, web and clamd images exactly as the Deploy workflow does (same Dockerfile
# targets, the web app pointed at the API's address in the cluster, today's virus signatures),
# tags them with the current commit and pushes them. Prints the three image URIs for
# terraform.tfvars (api_image, web_image, clamd_image).
set -euo pipefail

account=${1:?account id}
region=${AWS_REGION:-us-east-1}
registry="$account.dkr.ecr.$region.amazonaws.com"

if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has changes; commit them first so the tag names what was built." >&2
  exit 1
fi
tag=$(git rev-parse HEAD)

actual=$(aws sts get-caller-identity --query Account --output text)
if [ "$actual" != "$account" ]; then
  echo "AWS credentials are for account $actual, not $account (check AWS_PROFILE)." >&2
  exit 1
fi

aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$registry"

# The images run on Fargate's x86_64 tasks (ecs.tf runtime_platform), whatever this machine is.
docker buildx build --platform linux/amd64 --target api -t "$registry/acct/api:$tag" --push .
docker buildx build --platform linux/amd64 --target web \
  --build-arg API_URL=http://api.acct.internal:4000 -t "$registry/acct/web:$tag" --push .
docker buildx build --platform linux/amd64 --target clamd \
  --build-arg SIGNATURES_DATE="$(date -u +%F)" -t "$registry/acct/clamd:$tag" --push .

echo
echo "api_image   = \"$registry/acct/api:$tag\""
echo "web_image   = \"$registry/acct/web:$tag\""
echo "clamd_image = \"$registry/acct/clamd:$tag\""
