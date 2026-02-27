#!/bin/bash
set -euo pipefail

# =============================================================================
# download-qwen-models.sh - Download Qwen-Image-2512 models to S3
#
# Run on EC2 instance (downloads via wget from HuggingFace, uploads to S3).
# Downloads INT4 quantized models + text encoder + VAE + NSFW LoRAs.
#
# Usage:
#   ./scripts/download-qwen-models.sh              # Download all
#   ./scripts/download-qwen-models.sh --dit-only   # DiT model only
#   ./scripts/download-qwen-models.sh --lora-only  # LoRAs only
# =============================================================================

REGION="${AWS_REGION:-us-east-1}"
S3_BUCKET="${S3_BUCKET:-r18-anime-assets}"
WORK_DIR="/tmp/qwen-models"
HF_BASE="https://huggingface.co"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

DIT_ONLY=false
LORA_ONLY=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dit-only) DIT_ONLY=true; shift ;;
        --lora-only) LORA_ONLY=true; shift ;;
        -h|--help)
            echo "Usage: $0 [--dit-only|--lora-only]"
            exit 0 ;;
        *) echo "Unknown: $1"; exit 1 ;;
    esac
done

hf_download() {
    local repo="$1" file="$2" dest="$3"
    local url="${HF_BASE}/${repo}/resolve/main/${file}"
    log "  wget: ${url}"
    wget -q -O "${dest}" "${url}"
    log "  Downloaded: $(du -h "${dest}" | cut -f1)"
}

mkdir -p "${WORK_DIR}"

# ---- 1. Quantized DiT transformer (INT4 for non-RTX-50 GPUs) ----
if [[ "${LORA_ONLY}" != "true" ]]; then
    log "=== Downloading Qwen-Image-2512 INT4 DiT models ==="
    mkdir -p "${WORK_DIR}/diffusion_models"

    for variant in balance best_quality; do
        FILENAME="nunchaku_qwen_image_2512_${variant}_int4.safetensors"
        S3_KEY="models/qwen/diffusion_models/${FILENAME}"
        if aws s3 ls "s3://${S3_BUCKET}/${S3_KEY}" --region "${REGION}" &>/dev/null; then
            log "  Already exists: ${FILENAME}"
        else
            hf_download "QuantFunc/Nunchaku-Qwen-Image-2512" "${FILENAME}" "${WORK_DIR}/diffusion_models/${FILENAME}"
            aws s3 cp "${WORK_DIR}/diffusion_models/${FILENAME}" "s3://${S3_BUCKET}/${S3_KEY}" --region "${REGION}"
            log "  Uploaded: ${FILENAME}"
            rm -f "${WORK_DIR}/diffusion_models/${FILENAME}"
        fi
    done

    # ---- 2. Text encoder (FP8 quantized Qwen2.5-VL 7B) ----
    log "=== Downloading Qwen-Image text encoder ==="
    TE_FILE="qwen_2.5_vl_7b_fp8_scaled.safetensors"
    S3_KEY="models/qwen/text_encoders/${TE_FILE}"
    if aws s3 ls "s3://${S3_BUCKET}/${S3_KEY}" --region "${REGION}" &>/dev/null; then
        log "  Already exists: ${TE_FILE}"
    else
        hf_download "Comfy-Org/Qwen-Image_ComfyUI" "split_files/text_encoders/${TE_FILE}" "${WORK_DIR}/${TE_FILE}"
        aws s3 cp "${WORK_DIR}/${TE_FILE}" "s3://${S3_BUCKET}/${S3_KEY}" --region "${REGION}"
        log "  Uploaded: ${TE_FILE}"
        rm -f "${WORK_DIR}/${TE_FILE}"
    fi

    # ---- 3. VAE ----
    log "=== Downloading Qwen-Image VAE ==="
    VAE_FILE="qwen_image_vae.safetensors"
    S3_KEY="models/qwen/vae/${VAE_FILE}"
    if aws s3 ls "s3://${S3_BUCKET}/${S3_KEY}" --region "${REGION}" &>/dev/null; then
        log "  Already exists: ${VAE_FILE}"
    else
        hf_download "Comfy-Org/Qwen-Image_ComfyUI" "split_files/vae/${VAE_FILE}" "${WORK_DIR}/${VAE_FILE}"
        aws s3 cp "${WORK_DIR}/${VAE_FILE}" "s3://${S3_BUCKET}/${S3_KEY}" --region "${REGION}"
        log "  Uploaded: ${VAE_FILE}"
        rm -f "${WORK_DIR}/${VAE_FILE}"
    fi
fi

# ---- 4. NSFW LoRAs ----
if [[ "${DIT_ONLY}" != "true" ]]; then
    log "=== Downloading NSFW LoRAs ==="

    # starsfriday/Qwen-Image-NSFW (most popular, trigger: "rsq")
    NSFW_LORA="qwen_image_nsfw.safetensors"
    S3_KEY="models/qwen/loras/${NSFW_LORA}"
    if aws s3 ls "s3://${S3_BUCKET}/${S3_KEY}" --region "${REGION}" &>/dev/null; then
        log "  Already exists: ${NSFW_LORA}"
    else
        hf_download "starsfriday/Qwen-Image-NSFW" "${NSFW_LORA}" "${WORK_DIR}/${NSFW_LORA}"
        aws s3 cp "${WORK_DIR}/${NSFW_LORA}" "s3://${S3_BUCKET}/${S3_KEY}" --region "${REGION}"
        log "  Uploaded: ${NSFW_LORA}"
        rm -f "${WORK_DIR}/${NSFW_LORA}"
    fi

    # Hoshino-Yumetsuki/qwen-image-anime-nsfw-lora (anime-specific)
    ANIME_LORA="qwen-image-anime-nsfw-lora.safetensors"
    S3_KEY="models/qwen/loras/${ANIME_LORA}"
    if aws s3 ls "s3://${S3_BUCKET}/${S3_KEY}" --region "${REGION}" &>/dev/null; then
        log "  Already exists: ${ANIME_LORA}"
    else
        # Try common filename patterns from this repo
        ANIME_URL="${HF_BASE}/Hoshino-Yumetsuki/qwen-image-anime-nsfw-lora/resolve/main"
        log "  Trying anime NSFW LoRA download..."
        # Try direct filename first
        if wget -q --spider "${ANIME_URL}/${ANIME_LORA}" 2>/dev/null; then
            wget -q -O "${WORK_DIR}/${ANIME_LORA}" "${ANIME_URL}/${ANIME_LORA}"
        elif wget -q --spider "${ANIME_URL}/anime_nsfw_lora.safetensors" 2>/dev/null; then
            wget -q -O "${WORK_DIR}/${ANIME_LORA}" "${ANIME_URL}/anime_nsfw_lora.safetensors"
        else
            # List files via API to find the safetensors file
            log "  Checking repo file listing..."
            LORA_FILE=$(curl -s "${HF_BASE}/api/models/Hoshino-Yumetsuki/qwen-image-anime-nsfw-lora/tree/main" | python3 -c "import sys,json; files=[f['path'] for f in json.load(sys.stdin) if f['path'].endswith('.safetensors')]; print(files[0] if files else '')" 2>/dev/null || echo "")
            if [[ -n "${LORA_FILE}" ]]; then
                wget -q -O "${WORK_DIR}/${ANIME_LORA}" "${ANIME_URL}/${LORA_FILE}"
            else
                log "  WARNING: Could not find safetensors file in anime-nsfw-lora repo. Skipping."
            fi
        fi
        if [[ -f "${WORK_DIR}/${ANIME_LORA}" ]]; then
            aws s3 cp "${WORK_DIR}/${ANIME_LORA}" "s3://${S3_BUCKET}/${S3_KEY}" --region "${REGION}"
            log "  Uploaded: ${ANIME_LORA}"
            rm -f "${WORK_DIR}/${ANIME_LORA}"
        fi
    fi
fi

# ---- Summary ----
log ""
log "============================================================"
log "  Qwen model download complete"
log "============================================================"
log ""
log "  S3 contents:"
aws s3 ls "s3://${S3_BUCKET}/models/qwen/" --recursive --human-readable --region "${REGION}" 2>/dev/null || true
log ""
log "  Cleanup temp: rm -rf ${WORK_DIR}"
log "============================================================"

rm -rf "${WORK_DIR}"
