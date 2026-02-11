#!/bin/bash
set -euo pipefail

# ============================================================================
# sync-output.sh - EBS output/logs/workflows -> S3 sync
# Usage: sync-output.sh [--dry-run]
#   --dry-run  Preview sync without transferring files
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env from script directory or parent
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
    # shellcheck source=/dev/null
    source "${SCRIPT_DIR}/.env"
elif [[ -f "${SCRIPT_DIR}/../.env" ]]; then
    # shellcheck source=/dev/null
    source "${SCRIPT_DIR}/../.env"
fi

# Config with defaults
S3_BUCKET="${S3_BUCKET:?ERROR: S3_BUCKET is not set. Create .env or export S3_BUCKET.}"
DATA_DIR="${DATA_DIR:-/data}"

# Dry run flag
DRY_RUN=""
DRY_RUN_LABEL=""
if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN="--dryrun"
    DRY_RUN_LABEL=" (DRY RUN)"
elif [[ -n "${1:-}" ]]; then
    echo "Usage: $0 [--dry-run]"
    echo "  --dry-run  Preview sync without transferring files"
    exit 1
fi

# Sync targets: local_path -> s3_prefix
declare -A SYNC_TARGETS=(
    ["${DATA_DIR}/ComfyUI/output"]="output"
    ["${DATA_DIR}/logs"]="logs"
    ["${DATA_DIR}/ComfyUI/user"]="workflows"
)

declare -A SYNC_LABELS=(
    ["${DATA_DIR}/ComfyUI/output"]="Generated images"
    ["${DATA_DIR}/logs"]="Generation logs"
    ["${DATA_DIR}/ComfyUI/user"]="Workflows"
)

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

log "=== Output Sync${DRY_RUN_LABEL} ==="
log "S3 bucket: s3://${S3_BUCKET}/"
log "Data dir:  ${DATA_DIR}/"
echo ""

TOTAL_FILES=0
TOTAL_ERRORS=0

for local_path in "${!SYNC_TARGETS[@]}"; do
    s3_prefix="${SYNC_TARGETS[$local_path]}"
    label="${SYNC_LABELS[$local_path]}"
    s3_path="s3://${S3_BUCKET}/${s3_prefix}/"

    if [[ ! -d "${local_path}" ]]; then
        log "[SKIP] ${label}: ${local_path} does not exist"
        echo ""
        continue
    fi

    # Count local files before sync
    local_count=$(find "${local_path}" -type f 2>/dev/null | wc -l | tr -d ' ')

    log "[SYNC] ${label}: ${local_path} -> ${s3_path} (${local_count} local files)"

    # shellcheck disable=SC2086
    sync_output=$(aws s3 sync "${local_path}" "${s3_path}" ${DRY_RUN} 2>&1) || {
        log "[ERROR] Failed to sync ${label}"
        echo "${sync_output}"
        TOTAL_ERRORS=$((TOTAL_ERRORS + 1))
        continue
    }

    # Count transferred files from output
    file_count=$(echo "${sync_output}" | grep -c "^upload\|^(dryrun)" || true)
    TOTAL_FILES=$((TOTAL_FILES + file_count))

    if [[ ${file_count} -gt 0 ]]; then
        log "[DONE] ${label}: ${file_count} file(s) to transfer"
        echo "${sync_output}"
    else
        log "[DONE] ${label}: already up to date"
    fi
    echo ""
done

log "=== Sync Complete${DRY_RUN_LABEL} ==="
log "Total files synced: ${TOTAL_FILES}"
if [[ ${TOTAL_ERRORS} -gt 0 ]]; then
    log "Errors: ${TOTAL_ERRORS}"
    exit 1
fi
