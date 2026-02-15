#!/bin/bash
set -euo pipefail

# =============================================================================
# start-batch-eval.sh - Trigger Step Functions evaluation run
#
# Usage:
#   ./scripts/start-batch-eval.sh                     # All 13 models
#   ./scripts/start-batch-eval.sh --models "dreamshaper-8,autismmix-sdxl"  # Specific models
#   ./scripts/start-batch-eval.sh --dry-run            # Dry run (no generation)
#   ./scripts/start-batch-eval.sh --status             # Check running execution
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Load .env first (overrides system env vars)
if [[ -f "${REPO_ROOT}/.env" ]]; then
    set -a; source "${REPO_ROOT}/.env"; set +a
fi

REGION="${AWS_REGION:-us-east-1}"
STATE_MACHINE_NAME="r18-anime-eval"

# All 13 models
ALL_MODELS=(
    "wai-nsfw-illustrious-v16"
    "wai-nsfw-illustrious-v14"
    "wai-nsfw-illustrious-v12"
    "wai-nsfw-illustrious-v11"
    "wai-branch-rouwei"
    "illustrij-v20"
    "nova-anime-xl-il"
    "autismmix-sdxl"
    "pony-diffusion-v6-xl"
    "animagine-xl-4.0"
    "femix-hassakuxl"
    "dreamshaper-8"
    "aam-anylora-anime-mix"
)

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# Parse args
MODEL_FILTER=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --models) MODEL_FILTER="$2"; shift 2 ;;
        --dry-run) echo "dry-run is not supported via Step Functions (use Docker locally instead)"; exit 1 ;;
        --status) STATUS=true; shift ;;
        -h|--help)
            cat << 'EOF'
Usage: start-batch-eval.sh [OPTIONS]

Options:
  --models "m1,m2,..."   Run specific models only
  --dry-run              Pass DRY_RUN=true to containers
  --status               Show running executions

Models: wai-nsfw-illustrious-v16, v14, v12, v11, wai-branch-rouwei,
        illustrij-v20, nova-anime-xl-il, autismmix-sdxl,
        pony-diffusion-v6-xl, animagine-xl-4.0, femix-hassakuxl,
        dreamshaper-8, aam-anylora-anime-mix
EOF
            exit 0 ;;
        *) echo "Unknown: $1"; exit 1 ;;
    esac
done

# Get state machine ARN
SM_ARN=$(aws stepfunctions list-state-machines --region "${REGION}" \
    --query "stateMachines[?name=='${STATE_MACHINE_NAME}'].stateMachineArn | [0]" \
    --output text)

if [[ -z "${SM_ARN}" || "${SM_ARN}" == "None" ]]; then
    echo "ERROR: State machine '${STATE_MACHINE_NAME}' not found"
    echo "Deploy first: aws cloudformation deploy --template-file aws/batch-cloudformation.yml ..."
    exit 1
fi

# Status mode
if [[ "${STATUS:-}" == "true" ]]; then
    log "=== Running Executions ==="
    aws stepfunctions list-executions --region "${REGION}" \
        --state-machine-arn "${SM_ARN}" \
        --status-filter RUNNING \
        --query 'executions[].{name:name, start:startDate, status:status}' \
        --output table
    exit 0
fi

# Build model list
MODELS=()
if [[ -n "${MODEL_FILTER}" ]]; then
    IFS=',' read -ra MODELS <<< "${MODEL_FILTER}"
else
    MODELS=("${ALL_MODELS[@]}")
fi

# Build input JSON (jobName: dots replaced with hyphens for Batch job name safety)
MODELS_JSON="["
first=true
for model in "${MODELS[@]}"; do
    job_name="${model//./-}"
    [[ "$first" == "true" ]] && first=false || MODELS_JSON+=","
    MODELS_JSON+="{\"model\":\"${model}\",\"jobName\":\"${job_name}\"}"
done
MODELS_JSON+="]"

INPUT_JSON="{\"models\":${MODELS_JSON}}"

log "Starting evaluation:"
log "  State Machine: ${SM_ARN}"
log "  Models: ${#MODELS[@]}"
for m in "${MODELS[@]}"; do
    log "    - ${m}"
done

# Start execution
EXEC_NAME="eval-$(date +%Y%m%d-%H%M%S)"
EXEC_ARN=$(aws stepfunctions start-execution --region "${REGION}" \
    --state-machine-arn "${SM_ARN}" \
    --name "${EXEC_NAME}" \
    --input "${INPUT_JSON}" \
    --query 'executionArn' --output text)

log ""
log "============================================================"
log "  Execution started: ${EXEC_NAME}"
log "============================================================"
log "  ARN: ${EXEC_ARN}"
log "  Models: ${#MODELS[@]} parallel jobs"
log ""
log "  Monitor:"
log "    $0 --status"
log "    aws stepfunctions describe-execution --execution-arn '${EXEC_ARN}'"
log ""
log "  Batch logs:"
log "    aws logs tail /aws/batch/r18-anime-eval --follow"
log ""
log "  Console:"
log "    https://${REGION}.console.aws.amazon.com/states/home?region=${REGION}#/v2/executions/details/${EXEC_ARN}"
log "============================================================"
