#!/bin/bash
set -euo pipefail

# =============================================================================
# parallel-eval.sh - 13モデル比較画像をSpot並列生成
#
# 手順:
#   1. 現在稼働中インスタンスからAMI作成
#   2. AMIから4台のSpotワーカーを起動
#   3. 各ワーカーが割り当てモデルでgenerate-eval.py実行
#   4. 結果はS3に自動アップロード
#   5. 完了後ワーカーは自動終了
#
# Usage:
#   ./parallel-eval.sh                    # AMI作成→起動→生成
#   ./parallel-eval.sh --skip-ami AMI_ID  # 既存AMI使用
#   ./parallel-eval.sh --status           # 進捗確認
#   ./parallel-eval.sh --cleanup          # 全ワーカー終了+AMI削除
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGION="us-east-1"
INSTANCE_TYPE="g5.xlarge"  # g6e.xlargeが取れなければg5にフォールバック
PREFERRED_INSTANCE_TYPE="g6e.xlarge"
NUM_WORKERS=4
S3_BUCKET="r18-anime-assets"
STATE_FILE="/tmp/parallel-eval-state.json"

# Load .env
if [[ -f "${SCRIPT_DIR}/../.env" ]]; then
    set -a; source "${SCRIPT_DIR}/../.env"; set +a
fi

log() { echo "[$(date '+%H:%M:%S')] $*"; }
err() { log "ERROR: $*" >&2; }

# ワーカー割り当て（時間バランス済み）
# SDXL ~10s/枚, SD1.5 ~5s/枚 → Worker4にSD1.5+SDXL2つで均等化
WORKER_MODELS=(
    "wai-nsfw-illustrious-v16,wai-nsfw-illustrious-v14,wai-nsfw-illustrious-v12"
    "wai-nsfw-illustrious-v11,wai-branch-rouwei,illustrij-v20"
    "nova-anime-xl-il,femix-hassakuxl,animagine-xl-4.0"
    "autismmix-sdxl,pony-diffusion-v6-xl,dreamshaper-8,aam-anylora-anime-mix"
)

WORKER_NAMES=("wai-main" "wai-alt" "sdxl-other" "pony-sd15")

# =============================================================================
# Find source instance (the one currently running with our tag)
# =============================================================================
find_source_instance() {
    aws ec2 describe-instances --region "${REGION}" \
        --filters "Name=tag:Name,Values=r18-anime-gpu" \
                  "Name=instance-state-name,Values=running" \
        --query 'Reservations[0].Instances[0].InstanceId' \
        --output text 2>/dev/null
}

# =============================================================================
# Create AMI from running instance
# =============================================================================
create_ami() {
    local source_id="$1"
    local ami_name="r18-anime-eval-$(date +%Y%m%d-%H%M)"

    log "Creating AMI from ${source_id}..."
    local ami_id
    ami_id=$(aws ec2 create-image --region "${REGION}" \
        --instance-id "${source_id}" \
        --name "${ami_name}" \
        --description "r18-anime eval: 13 models + ComfyUI + custom nodes" \
        --no-reboot \
        --query 'ImageId' --output text)

    log "AMI: ${ami_id} (${ami_name})"
    log "Waiting for AMI to become available (this takes a few minutes)..."

    aws ec2 wait image-available --region "${REGION}" --image-ids "${ami_id}"
    log "AMI ready: ${ami_id}"
    echo "${ami_id}"
}

# =============================================================================
# Launch a single Spot worker
# =============================================================================
launch_worker() {
    local ami_id="$1"
    local worker_idx="$2"
    local models="${WORKER_MODELS[$worker_idx]}"
    local name="${WORKER_NAMES[$worker_idx]}"

    # UserData script: mount data volume, start ComfyUI, run generate-eval.py, self-terminate
    local userdata
    userdata=$(cat <<'USERDATA_EOF'
#!/bin/bash
set -euo pipefail
exec > /var/log/eval-worker.log 2>&1

echo "=== Eval Worker Starting ==="
echo "Models: __MODELS__"
echo "Worker: __NAME__"

# Data volume is already part of the AMI snapshot
# Just ensure it's mounted
if ! mountpoint -q /data; then
    # Find the data volume device
    for dev in /dev/nvme1n1 /dev/xvdf /dev/sdf; do
        if [[ -b "$dev" ]]; then
            mount "$dev" /data 2>/dev/null && break
            # Try partition
            [[ -b "${dev}p1" ]] && mount "${dev}p1" /data 2>/dev/null && break
        fi
    done
fi

if ! mountpoint -q /data; then
    echo "ERROR: Could not mount /data"
    shutdown -h now
    exit 1
fi

echo "Data volume mounted at /data"

# Start ComfyUI
cd /data/ComfyUI
source venv/bin/activate

# Start ComfyUI in background
python main.py --listen 0.0.0.0 --port 8188 --disable-auto-launch &
COMFYUI_PID=$!

# Wait for ComfyUI to be ready
for i in $(seq 1 60); do
    if curl -s http://127.0.0.1:8188/system_stats >/dev/null 2>&1; then
        echo "ComfyUI ready"
        break
    fi
    sleep 5
done

# Clone the repo to get latest generate-eval.py and prompts
cd /tmp
if [[ -d r18_anime ]]; then rm -rf r18_anime; fi
git clone --depth 1 https://github.com/Miyanorococo/ahan18girl.git r18_anime 2>/dev/null || true

# Run generation
cd /tmp/r18_anime
COMFYUI_URL=http://127.0.0.1:8188 \
S3_BUCKET=__S3_BUCKET__ \
python3 scripts/generate-eval.py --models "__MODELS__"

echo "=== Generation complete ==="

# Stop ComfyUI
kill $COMFYUI_PID 2>/dev/null || true

# Signal completion via S3
aws s3 cp - "s3://__S3_BUCKET__/eval-status/__NAME__-done.txt" <<< "done $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Self-terminate
echo "Self-terminating..."
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
aws ec2 terminate-instances --region __REGION__ --instance-ids "$INSTANCE_ID"
USERDATA_EOF
)

    # Replace placeholders
    userdata="${userdata//__MODELS__/$models}"
    userdata="${userdata//__NAME__/$name}"
    userdata="${userdata//__S3_BUCKET__/$S3_BUCKET}"
    userdata="${userdata//__REGION__/$REGION}"

    local encoded_userdata
    encoded_userdata=$(echo "$userdata" | base64)

    # Try preferred instance type first, fallback to g5
    local actual_type="${PREFERRED_INSTANCE_TYPE}"
    local instance_id

    # Get subnet and SG from .env
    local subnet="${PRIVATE_SUBNET_ID:-${SUBNET_ID}}"
    local sg="${SG_ID}"

    log "Launching worker-${worker_idx} (${name}): ${actual_type} spot..."

    instance_id=$(aws ec2 run-instances --region "${REGION}" \
        --image-id "${ami_id}" \
        --instance-type "${actual_type}" \
        --subnet-id "${subnet}" \
        --security-group-ids "${sg}" \
        --iam-instance-profile "Name=r18-anime-ec2-role" \
        --instance-market-options '{"MarketType":"spot","SpotOptions":{"SpotInstanceType":"one-time"}}' \
        --user-data "${encoded_userdata}" \
        --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=r18-eval-${name}},{Key=Purpose,Value=eval-batch}]" \
        --query 'Instances[0].InstanceId' --output text 2>/dev/null) || true

    if [[ -z "${instance_id}" || "${instance_id}" == "None" ]]; then
        log "  g6e spot unavailable, trying g5..."
        actual_type="${INSTANCE_TYPE}"
        instance_id=$(aws ec2 run-instances --region "${REGION}" \
            --image-id "${ami_id}" \
            --instance-type "${actual_type}" \
            --subnet-id "${subnet}" \
            --security-group-ids "${sg}" \
            --iam-instance-profile "Name=r18-anime-ec2-role" \
            --instance-market-options '{"MarketType":"spot","SpotOptions":{"SpotInstanceType":"one-time"}}' \
            --user-data "${encoded_userdata}" \
            --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=r18-eval-${name}},{Key=Purpose,Value=eval-batch}]" \
            --query 'Instances[0].InstanceId' --output text)
    fi

    log "  Worker ${name}: ${instance_id} (${actual_type})"
    echo "${instance_id}"
}

# =============================================================================
# Check progress via S3
# =============================================================================
check_progress() {
    log "=== Progress ==="
    local total_expected=6435
    local total_done=0

    for name in "${WORKER_NAMES[@]}"; do
        local done_marker
        done_marker=$(aws s3 ls "s3://${S3_BUCKET}/eval-status/${name}-done.txt" --region "${REGION}" 2>/dev/null || true)
        if [[ -n "$done_marker" ]]; then
            log "  ${name}: ✅ DONE"
        else
            log "  ${name}: 🔄 running"
        fi
    done

    # Count images in S3
    local image_count
    image_count=$(aws s3 ls "s3://${S3_BUCKET}/gallery/experiments/$(date +%Y%m%d)_" \
        --region "${REGION}" --recursive 2>/dev/null | grep -c "\.png$" || echo 0)
    log "  Images in S3: ${image_count} / ${total_expected}"

    # Check running eval instances
    local running
    running=$(aws ec2 describe-instances --region "${REGION}" \
        --filters "Name=tag:Purpose,Values=eval-batch" \
                  "Name=instance-state-name,Values=running,pending" \
        --query 'Reservations[].Instances[].[InstanceId,InstanceType,Tags[?Key==`Name`].Value|[0]]' \
        --output text 2>/dev/null || true)
    if [[ -n "$running" ]]; then
        log "  Running workers:"
        echo "$running" | while read -r id type tag; do
            log "    ${tag}: ${id} (${type})"
        done
    else
        log "  No workers running"
    fi
}

# =============================================================================
# Cleanup: terminate workers + deregister AMI
# =============================================================================
cleanup() {
    log "=== Cleanup ==="

    # Terminate eval workers
    local worker_ids
    worker_ids=$(aws ec2 describe-instances --region "${REGION}" \
        --filters "Name=tag:Purpose,Values=eval-batch" \
                  "Name=instance-state-name,Values=running,pending,stopping" \
        --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null || true)

    if [[ -n "$worker_ids" && "$worker_ids" != "None" ]]; then
        log "Terminating workers: ${worker_ids}"
        aws ec2 terminate-instances --region "${REGION}" --instance-ids ${worker_ids} >/dev/null
    else
        log "No eval workers to terminate"
    fi

    # Deregister AMI
    local ami_ids
    ami_ids=$(aws ec2 describe-images --region "${REGION}" --owners self \
        --filters "Name=name,Values=r18-anime-eval-*" \
        --query 'Images[].ImageId' --output text 2>/dev/null || true)

    if [[ -n "$ami_ids" && "$ami_ids" != "None" ]]; then
        for ami in ${ami_ids}; do
            log "Deregistering AMI: ${ami}"
            # Get snapshot IDs first
            local snaps
            snaps=$(aws ec2 describe-images --region "${REGION}" --image-ids "${ami}" \
                --query 'Images[0].BlockDeviceMappings[].Ebs.SnapshotId' --output text 2>/dev/null || true)
            aws ec2 deregister-image --region "${REGION}" --image-id "${ami}" 2>/dev/null || true
            for snap in ${snaps}; do
                [[ "$snap" == "None" ]] && continue
                log "  Deleting snapshot: ${snap}"
                aws ec2 delete-snapshot --region "${REGION}" --snapshot-id "${snap}" 2>/dev/null || true
            done
        done
    fi

    # Clean up status markers
    aws s3 rm "s3://${S3_BUCKET}/eval-status/" --recursive --region "${REGION}" 2>/dev/null || true

    log "Cleanup complete"
}

# =============================================================================
# Main
# =============================================================================
main() {
    local skip_ami=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --skip-ami) skip_ami="$2"; shift 2 ;;
            --status) check_progress; exit 0 ;;
            --cleanup) cleanup; exit 0 ;;
            -h|--help)
                echo "Usage: $0 [--skip-ami AMI_ID] [--status] [--cleanup]"
                exit 0 ;;
            *) err "Unknown: $1"; exit 1 ;;
        esac
    done

    # Step 1: Find source instance
    local source_id
    source_id=$(find_source_instance)
    if [[ -z "$source_id" || "$source_id" == "None" ]]; then
        err "No running r18-anime-gpu instance found"
        exit 1
    fi
    log "Source instance: ${source_id}"

    # Step 2: Create AMI (or use existing)
    local ami_id
    if [[ -n "$skip_ami" ]]; then
        ami_id="$skip_ami"
        log "Using existing AMI: ${ami_id}"
    else
        ami_id=$(create_ami "${source_id}")
    fi

    # Step 3: Launch workers
    log "Launching ${NUM_WORKERS} workers..."
    local worker_ids=()
    for i in $(seq 0 $((NUM_WORKERS - 1))); do
        local wid
        wid=$(launch_worker "${ami_id}" "$i")
        worker_ids+=("$wid")
    done

    # Save state
    cat > "${STATE_FILE}" <<EOF
{
    "ami_id": "${ami_id}",
    "workers": [
        $(for i in $(seq 0 $((NUM_WORKERS - 1))); do
            echo "    {\"id\": \"${worker_ids[$i]}\", \"name\": \"${WORKER_NAMES[$i]}\", \"models\": \"${WORKER_MODELS[$i]}\"}"
            [[ $i -lt $((NUM_WORKERS - 1)) ]] && echo ","
        done)
    ],
    "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

    log ""
    log "============================================================"
    log "  Parallel eval started"
    log "============================================================"
    log "  AMI:     ${ami_id}"
    log "  Workers: ${NUM_WORKERS}"
    for i in $(seq 0 $((NUM_WORKERS - 1))); do
        log "    ${WORKER_NAMES[$i]}: ${worker_ids[$i]}"
        log "      models: ${WORKER_MODELS[$i]}"
    done
    log "------------------------------------------------------------"
    log "  Monitor:  $0 --status"
    log "  Cleanup:  $0 --cleanup"
    log "  Workers self-terminate on completion"
    log "============================================================"
}

main "$@"
