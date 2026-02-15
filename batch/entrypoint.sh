#!/bin/bash
set -euo pipefail

# Ensure ComfyUI is always cleaned up on exit
cleanup() {
    if [ -n "${COMFYUI_PID:-}" ]; then
        kill ${COMFYUI_PID} 2>/dev/null || true
    fi
}
trap cleanup EXIT

# =============================================================================
# Batch entrypoint: S3 model download → ComfyUI → generate-eval.py
#
# Environment variables (injected by Batch Job Definition / Step Functions):
#   MODEL_NAME   - Model key, e.g. "wai-nsfw-illustrious-v16"
#   S3_BUCKET    - S3 bucket (default: r18-anime-assets)
#   DRY_RUN      - If "true", run generate-eval.py --dry-run
# =============================================================================

log() { echo "[$(date '+%H:%M:%S')] $*"; }

MODEL_NAME="${MODEL_NAME:?MODEL_NAME is required}"
S3_BUCKET="${S3_BUCKET:-r18-anime-assets}"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
COMFYUI_DIR="/opt/ComfyUI"

# ---- Model name → S3 key mapping ----
# Checkpoint filenames match the CHECKPOINT_MAP in generate-eval.py
CHECKPOINT_FILE="${MODEL_NAME}.safetensors"
S3_MODEL_KEY="models/checkpoints/${CHECKPOINT_FILE}"

# ---- Download model from S3 ----
log "Downloading model: s3://${S3_BUCKET}/${S3_MODEL_KEY}"
aws s3 cp "s3://${S3_BUCKET}/${S3_MODEL_KEY}" \
    "${COMFYUI_DIR}/models/checkpoints/${CHECKPOINT_FILE}" \
    --region "${REGION}" --only-show-errors

MODEL_SIZE=$(du -h "${COMFYUI_DIR}/models/checkpoints/${CHECKPOINT_FILE}" | cut -f1)
log "Model downloaded: ${CHECKPOINT_FILE} (${MODEL_SIZE})"

# ---- Download shared resources (VAE) if present ----
aws s3 cp "s3://${S3_BUCKET}/models/vae/" \
    "${COMFYUI_DIR}/models/vae/" \
    --region "${REGION}" --recursive --only-show-errors 2>/dev/null || true

# ---- Start ComfyUI in background ----
log "Starting ComfyUI..."
cd "${COMFYUI_DIR}"
python3 main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch --gpu-only &
COMFYUI_PID=$!

# Wait for ComfyUI to be ready
READY=false
for i in $(seq 1 60); do
    if curl -s http://127.0.0.1:8188/system_stats > /dev/null 2>&1; then
        log "ComfyUI ready (${i}x5s)"
        READY=true
        break
    fi
    sleep 5
done

if [ "${READY}" != "true" ]; then
    log "ERROR: ComfyUI did not start within 5 minutes"
    kill ${COMFYUI_PID} 2>/dev/null || true
    exit 1
fi

# ---- Run generation ----
EVAL_ARGS="--models ${MODEL_NAME}"
if [ "${DRY_RUN:-}" = "true" ]; then
    EVAL_ARGS="${EVAL_ARGS} --dry-run"
fi

log "Starting generation: ${MODEL_NAME}"
cd /opt/eval
python3 scripts/generate-eval.py ${EVAL_ARGS}
EXIT_CODE=$?

log "Generation complete (exit=${EXIT_CODE})"
exit ${EXIT_CODE}
