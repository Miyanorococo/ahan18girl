#!/bin/bash
set -euo pipefail

# ============================================================================
# sync-models.sh - S3 <-> EBS model synchronization
# Usage: sync-models.sh [--download|--upload]
#   --download  S3 -> EBS (default)
#   --upload    EBS -> S3
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
MODELS_DIR="${MODELS_DIR:-${DATA_DIR}/ComfyUI/models}"

# Direction: download (default) or upload
DIRECTION="download"
if [[ "${1:-}" == "--upload" ]]; then
    DIRECTION="upload"
elif [[ "${1:-}" == "--download" ]]; then
    DIRECTION="download"
elif [[ -n "${1:-}" ]]; then
    echo "Usage: $0 [--download|--upload]"
    echo "  --download  S3 -> EBS (default)"
    echo "  --upload    EBS -> S3"
    exit 1
fi

# Mapping: S3 prefix -> local directory name
# S3 uses "upscalers/" but ComfyUI expects "upscale_models/"
declare -A S3_TO_LOCAL=(
    ["checkpoints"]="checkpoints"
    ["loras"]="loras"
    ["controlnet"]="controlnet"
    ["upscalers"]="upscale_models"
    ["vae"]="vae"
)

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

log "=== Model Sync: ${DIRECTION} ==="
log "S3 bucket:  s3://${S3_BUCKET}/models/"
log "Local dir:  ${MODELS_DIR}/"
log "Direction:  ${DIRECTION}"
echo ""

TOTAL_FILES=0
TOTAL_ERRORS=0

for s3_subdir in "${!S3_TO_LOCAL[@]}"; do
    local_subdir="${S3_TO_LOCAL[$s3_subdir]}"
    s3_path="s3://${S3_BUCKET}/models/${s3_subdir}/"
    local_path="${MODELS_DIR}/${local_subdir}/"

    if [[ "${DIRECTION}" == "download" ]]; then
        src="${s3_path}"
        dst="${local_path}"
        # Ensure local directory exists for downloads
        mkdir -p "${dst}"
    else
        src="${local_path}"
        dst="${s3_path}"
        # Skip if local directory doesn't exist
        if [[ ! -d "${src}" ]]; then
            log "[SKIP] ${src} does not exist"
            continue
        fi
    fi

    log "[SYNC] ${s3_subdir}: ${src} -> ${dst}"

    sync_output=$(aws s3 sync "${src}" "${dst}" --size-only 2>&1) || {
        log "[ERROR] Failed to sync ${s3_subdir}"
        echo "${sync_output}"
        TOTAL_ERRORS=$((TOTAL_ERRORS + 1))
        continue
    }

    # Count transferred files from output
    file_count=$(echo "${sync_output}" | grep -c "^upload\|^download" || true)
    TOTAL_FILES=$((TOTAL_FILES + file_count))

    if [[ ${file_count} -gt 0 ]]; then
        log "[DONE] ${s3_subdir}: ${file_count} file(s) transferred"
        echo "${sync_output}"
    else
        log "[DONE] ${s3_subdir}: already up to date"
    fi
    echo ""
done

log "=== Sync Complete ==="
log "Total files transferred: ${TOTAL_FILES}"
if [[ ${TOTAL_ERRORS} -gt 0 ]]; then
    log "Errors: ${TOTAL_ERRORS}"
    exit 1
fi
