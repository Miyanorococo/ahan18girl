#!/bin/bash
set -euo pipefail

# =============================================================================
# build-and-push.sh - Docker build → ECR push for Batch eval image
#
# Usage:
#   ./scripts/build-and-push.sh              # Build and push
#   ./scripts/build-and-push.sh --no-push    # Build only (local testing)
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Load .env first (overrides system env vars)
if [[ -f "${REPO_ROOT}/.env" ]]; then
    set -a; source "${REPO_ROOT}/.env"; set +a
fi

REGION="${AWS_REGION:-us-east-1}"
REPO_NAME="r18-anime-eval"
IMAGE_TAG="latest"
NO_PUSH=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-push) NO_PUSH=true; shift ;;
        --tag) IMAGE_TAG="$2"; shift 2 ;;
        *) echo "Unknown: $1"; exit 1 ;;
    esac
done

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# Get AWS account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO_NAME}"

log "Building Docker image..."
log "  Context: ${REPO_ROOT}"
log "  Dockerfile: batch/Dockerfile"
log "  Tag: ${ECR_URI}:${IMAGE_TAG}"

cd "${REPO_ROOT}"
docker build \
    -f batch/Dockerfile \
    -t "${REPO_NAME}:${IMAGE_TAG}" \
    -t "${ECR_URI}:${IMAGE_TAG}" \
    .

log "Build complete"

if [[ "${NO_PUSH}" == "true" ]]; then
    log "Skipping push (--no-push)"
    log "Test locally: docker run --gpus all -e MODEL_NAME=dreamshaper-8 -e DRY_RUN=true ${REPO_NAME}:${IMAGE_TAG}"
    exit 0
fi

# ECR login
log "Logging in to ECR..."
aws ecr get-login-password --region "${REGION}" | \
    docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

# Push
log "Pushing to ECR..."
docker push "${ECR_URI}:${IMAGE_TAG}"

log "Pushed: ${ECR_URI}:${IMAGE_TAG}"
log ""
log "Next: Update CloudFormation DockerImageUri parameter:"
log "  ${ECR_URI}:${IMAGE_TAG}"
