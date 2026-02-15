#!/bin/bash
set -euo pipefail

# ============================================================================
# batch-experiment.sh - 実験画像を生成→Zip→S3アップロード
#
# Usage:
#   batch-experiment.sh --model "wai-nsfw-v16" --pipeline "txt2img" \
#     --prompt-summary "blonde-school" --params "steps30-cfg7-euler-a" \
#     --seed-start 42 --count 10 --source-dir /path/to/images
#
#   batch-experiment.sh --auto /path/to/images
#     (metadata.jsonから自動でZip名を生成)
#
# 機能:
#   1. 指定ディレクトリの画像をZipにまとめる
#   2. metadata.json を同梱
#   3. S3 experiments/ にアップロード
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load .env
if [[ -f "${SCRIPT_DIR}/../.env" ]]; then
    source "${SCRIPT_DIR}/../.env"
fi

S3_BUCKET="${S3_BUCKET:-illust-novel-ah18}"
DATE=$(date +%Y%m%d)

# Defaults
MODEL=""
PIPELINE="txt2img"
PROMPT_SUMMARY=""
PARAMS=""
SEED_START=0
COUNT=10
SOURCE_DIR=""
AUTO_MODE=false

usage() {
    cat <<'EOF'
Usage: batch-experiment.sh [OPTIONS] --source-dir <dir>

Options:
  --model <name>           モデル短縮名 (例: wai-nsfw-v16, flux-schnell)
  --pipeline <type>        パイプライン種別 (txt2img, img2img, pipeline1, pipeline2, inpaint)
  --prompt-summary <text>  プロンプト要約 3-5語 ハイフン区切り (例: blonde-school-uniform)
  --params <text>          パラメータ要約 (例: steps30-cfg7-euler-a)
  --seed-start <num>       開始シード値
  --count <num>            画像枚数 (default: 10)
  --source-dir <dir>       画像ソースディレクトリ
  --auto <dir>             metadata.jsonから自動命名 (source-dirのショートカット)
  --dry-run                S3アップロードをスキップ
  -h, --help               このヘルプを表示
EOF
    exit 0
}

DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --model)       MODEL="$2"; shift 2 ;;
        --pipeline)    PIPELINE="$2"; shift 2 ;;
        --prompt-summary) PROMPT_SUMMARY="$2"; shift 2 ;;
        --params)      PARAMS="$2"; shift 2 ;;
        --seed-start)  SEED_START="$2"; shift 2 ;;
        --count)       COUNT="$2"; shift 2 ;;
        --source-dir)  SOURCE_DIR="$2"; shift 2 ;;
        --auto)        AUTO_MODE=true; SOURCE_DIR="$2"; shift 2 ;;
        --dry-run)     DRY_RUN=true; shift ;;
        -h|--help)     usage ;;
        *)             echo "Unknown option: $1"; usage ;;
    esac
done

if [[ -z "${SOURCE_DIR}" ]]; then
    echo "ERROR: --source-dir or --auto is required"
    usage
fi

if [[ ! -d "${SOURCE_DIR}" ]]; then
    echo "ERROR: Source directory does not exist: ${SOURCE_DIR}"
    exit 1
fi

# Auto mode: read metadata.json for naming
if [[ "${AUTO_MODE}" == true ]] && [[ -f "${SOURCE_DIR}/metadata.json" ]]; then
    echo "[INFO] Auto mode: reading metadata.json"
    if command -v python3 &>/dev/null; then
        read_meta() {
            python3 -c "
import json, sys
with open('${SOURCE_DIR}/metadata.json') as f:
    m = json.load(f)
field = sys.argv[1]
if field == 'model':
    print(m.get('model', {}).get('checkpoint', 'unknown').lower().replace(' ', '-')[:30])
elif field == 'pipeline':
    print(m.get('pipeline', 'txt2img'))
elif field == 'prompt':
    p = m.get('prompt', {}).get('positive', '')
    words = p.split(',')[:4]
    print('-'.join(w.strip().replace(' ', '-')[:15] for w in words if w.strip())[:60])
elif field == 'params':
    p = m.get('parameters', {})
    parts = []
    if 'steps' in p: parts.append(f\"steps{p['steps']}\")
    if 'cfg_scale' in p: parts.append(f\"cfg{p['cfg_scale']}\")
    if 'sampler' in p: parts.append(p['sampler'].replace('_', ''))
    print('-'.join(parts))
elif field == 'seeds':
    seeds = m.get('seeds', [])
    if seeds:
        print(f\"{seeds[0]}x{len(seeds)}\")
    else:
        print('0x0')
elif field == 'count':
    print(len(m.get('seeds', [])))
" "$1"
        }
        [[ -z "${MODEL}" ]] && MODEL=$(read_meta model)
        [[ -z "${PROMPT_SUMMARY}" ]] && PROMPT_SUMMARY=$(read_meta prompt)
        [[ -z "${PARAMS}" ]] && PARAMS=$(read_meta params)
        SEED_INFO=$(read_meta seeds)
    fi
fi

# Validate required fields
if [[ -z "${MODEL}" ]]; then
    echo "ERROR: --model is required (or provide metadata.json with --auto)"
    exit 1
fi

# Count images
IMG_COUNT=$(find "${SOURCE_DIR}" -maxdepth 1 -type f \( -name "*.png" -o -name "*.jpg" -o -name "*.webp" \) | wc -l | tr -d ' ')
if [[ "${IMG_COUNT}" -eq 0 ]]; then
    echo "ERROR: No images found in ${SOURCE_DIR}"
    exit 1
fi

# Build zip name
SEED_PART="${SEED_INFO:-seed${SEED_START}x${COUNT}}"
ZIP_PARTS=("${DATE}" "${MODEL}" "${PIPELINE}")
[[ -n "${PROMPT_SUMMARY}" ]] && ZIP_PARTS+=("${PROMPT_SUMMARY}")
[[ -n "${PARAMS}" ]] && ZIP_PARTS+=("${PARAMS}")
ZIP_PARTS+=("${SEED_PART}")

# Join with underscore, sanitize
ZIP_NAME=$(printf "%s" "$(IFS=_; echo "${ZIP_PARTS[*]}")" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g' | sed 's/--*/-/g')
ZIP_NAME="${ZIP_NAME}.zip"

S3_PREFIX="experiments/${DATE}_${MODEL}"
S3_PATH="s3://${S3_BUCKET}/${S3_PREFIX}/${ZIP_NAME}"

echo "============================================"
echo "  Batch Experiment Packager"
echo "============================================"
echo "Source:     ${SOURCE_DIR}"
echo "Images:     ${IMG_COUNT} files"
echo "Zip name:   ${ZIP_NAME}"
echo "S3 path:    ${S3_PATH}"
echo ""

# Create temp directory and copy files
WORK_DIR=$(mktemp -d)
trap 'rm -rf "${WORK_DIR}"' EXIT

# Copy images with sequential naming
i=1
for img in $(find "${SOURCE_DIR}" -maxdepth 1 -type f \( -name "*.png" -o -name "*.jpg" -o -name "*.webp" \) | sort); do
    ext="${img##*.}"
    cp "${img}" "${WORK_DIR}/$(printf '%03d' ${i})_seed$(basename "${img}" ".${ext}").${ext}"
    i=$((i + 1))
done

# Copy metadata.json if exists
if [[ -f "${SOURCE_DIR}/metadata.json" ]]; then
    cp "${SOURCE_DIR}/metadata.json" "${WORK_DIR}/metadata.json"
    echo "[OK] metadata.json included"
else
    echo "[WARN] No metadata.json found in source directory"
fi

# Create zip
ZIP_PATH="/tmp/${ZIP_NAME}"
(cd "${WORK_DIR}" && zip -q -r "${ZIP_PATH}" .)
ZIP_SIZE=$(du -h "${ZIP_PATH}" | cut -f1)
echo "[OK] Zip created: ${ZIP_SIZE}"

# Upload to S3
if [[ "${DRY_RUN}" == true ]]; then
    echo "[DRY RUN] Would upload to: ${S3_PATH}"
else
    echo "[UPLOAD] Uploading to ${S3_PATH}..."
    aws s3 cp "${ZIP_PATH}" "${S3_PATH}" --quiet
    echo "[OK] Upload complete"
fi

echo ""
echo "============================================"
echo "  Done!"
echo "  ${S3_PATH}"
echo "============================================"
