#!/bin/bash
set -euo pipefail

# Model downloader for r18-anime (runs on EC2)
# Downloads models from HuggingFace to /data/ComfyUI/models/
# After download, syncs to S3 as backup

COMFYUI_DIR="${COMFYUI_DIR:-/data/ComfyUI}"
MODELS_DIR="$COMFYUI_DIR/models"
S3_BUCKET="${S3_BUCKET:-r18-anime-assets}"
MODELS_CONFIG="${MODELS_CONFIG:-}"

# Parse flags
SKIP_S3_SYNC=false
DRY_RUN=false
for arg in "$@"; do
    case "$arg" in
        --no-sync)  SKIP_S3_SYNC=true ;;
        --dry-run)  DRY_RUN=true ;;
        -h|--help)
            echo "Usage: $(basename "$0") [--no-sync] [--dry-run]"
            echo ""
            echo "Download models from HuggingFace to $MODELS_DIR"
            echo ""
            echo "Options:"
            echo "  --no-sync  Skip S3 backup after download"
            echo "  --dry-run  Show what would be downloaded without downloading"
            echo "  -h, --help Show this help"
            echo ""
            echo "Environment variables:"
            echo "  COMFYUI_DIR     ComfyUI root (default: /data/ComfyUI)"
            echo "  S3_BUCKET       S3 bucket for backup (default: r18-anime-assets)"
            echo "  MODELS_CONFIG   Path to models.yml (optional)"
            exit 0
            ;;
        *)
            echo "Error: Unknown option: $arg" >&2
            exit 1
            ;;
    esac
done

# --- Model definitions ---
# Format: "subdir|filename|url|expected_size_bytes"
# expected_size_bytes is optional (0 = skip size check)
MODELS=(
    # Checkpoints
    "checkpoints|wai-nsfw-illustrious-v16.safetensors|https://huggingface.co/WAI-NSFW-illustrious/WAI-NSFW-illustrious-SDXL-v16/resolve/main/wai-nsfw-illustrious-SDXL-v16.0.safetensors|0"
    "checkpoints|animagine-xl-4.0-opt.safetensors|https://huggingface.co/cagliostrolab/animagine-xl-4.0/resolve/main/animagine-xl-4.0-opt.safetensors|0"

    # VAE
    "vae|sdxl_vae.safetensors|https://huggingface.co/stabilityai/sdxl-vae/resolve/main/sdxl_vae.safetensors|0"

    # Upscalers
    "upscale_models|4x-FoolhardyRemacri.pth|https://huggingface.co/FacehugmanIII/4x_foolhardy_Remacri/resolve/main/4x_foolhardy_Remacri.pth|0"

    # ControlNet
    "controlnet|control-lora-openposeXL2-rank256.safetensors|https://huggingface.co/thibaud/controlnet-openpose-sdxl-1.0/resolve/main/control-lora-openposeXL2-rank256.safetensors|0"
)

# If a models.yml config is provided, parse additional models from it
if [[ -n "$MODELS_CONFIG" && -f "$MODELS_CONFIG" ]]; then
    echo "Loading additional models from $MODELS_CONFIG"
    # Parse YAML: expects entries like:
    #   - subdir: checkpoints
    #     filename: model.safetensors
    #     url: https://...
    #     size: 0
    while IFS= read -r line; do
        if [[ "$line" =~ ^[[:space:]]*-[[:space:]]*subdir:[[:space:]]*(.+) ]]; then
            subdir="${BASH_REMATCH[1]}"
            read -r line; filename=$(echo "$line" | sed 's/.*filename:[[:space:]]*//')
            read -r line; url=$(echo "$line" | sed 's/.*url:[[:space:]]*//')
            read -r line; size=$(echo "$line" | sed 's/.*size:[[:space:]]*//')
            MODELS+=("${subdir}|${filename}|${url}|${size:-0}")
        fi
    done < "$MODELS_CONFIG"
fi

# --- Download ---
TOTAL=${#MODELS[@]}
DOWNLOADED=0
SKIPPED=0
FAILED=0

echo "============================================"
echo "Model Downloader - r18_anime"
echo "Target: $MODELS_DIR"
echo "Models: $TOTAL"
echo "============================================"
echo ""

for entry in "${MODELS[@]}"; do
    IFS='|' read -r subdir filename url expected_size <<< "$entry"
    dest_dir="$MODELS_DIR/$subdir"
    dest_file="$dest_dir/$filename"

    echo "[$((DOWNLOADED + SKIPPED + FAILED + 1))/$TOTAL] $subdir/$filename"

    # Check if already downloaded
    if [[ -f "$dest_file" ]]; then
        actual_size=$(stat -c %s "$dest_file" 2>/dev/null || stat -f %z "$dest_file" 2>/dev/null || echo "0")
        if [[ "$expected_size" != "0" && "$actual_size" != "$expected_size" ]]; then
            echo "  Size mismatch (expected: $expected_size, actual: $actual_size). Re-downloading..."
        else
            echo "  Already exists ($actual_size bytes). Skipping."
            SKIPPED=$((SKIPPED + 1))
            continue
        fi
    fi

    if [[ "$DRY_RUN" == true ]]; then
        echo "  [DRY RUN] Would download from: $url"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    # Create directory and download
    mkdir -p "$dest_dir"
    echo "  Downloading from: $url"
    if curl -L -C - --retry 3 --retry-delay 5 -o "$dest_file" --progress-bar "$url"; then
        actual_size=$(stat -c %s "$dest_file" 2>/dev/null || stat -f %z "$dest_file" 2>/dev/null || echo "?")
        echo "  Done ($actual_size bytes)"
        DOWNLOADED=$((DOWNLOADED + 1))
    else
        echo "  FAILED to download" >&2
        rm -f "$dest_file"
        FAILED=$((FAILED + 1))
    fi
    echo ""
done

echo "============================================"
echo "Results: $DOWNLOADED downloaded, $SKIPPED skipped, $FAILED failed"
echo "============================================"

# --- S3 sync ---
if [[ "$SKIP_S3_SYNC" == true || "$DRY_RUN" == true ]]; then
    echo "Skipping S3 sync."
else
    echo ""
    echo "Syncing models to S3: s3://$S3_BUCKET/models/"
    aws s3 sync "$MODELS_DIR" "s3://$S3_BUCKET/models/" \
        --exclude "*.tmp" \
        --exclude "*.part"
    echo "S3 sync complete."
fi

if [[ "$FAILED" -gt 0 ]]; then
    exit 1
fi
