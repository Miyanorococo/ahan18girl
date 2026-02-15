#!/bin/bash
set -euo pipefail

# =============================================================================
# parallel-eval.sh - 13モデル比較画像をSpot並列生成
#
# 手順:
#   1. 現在稼働中インスタンスのEBSスナップショット作成
#   2. スナップショットからワーカーごとにEBSボリューム作成
#   3. ワーカーSpotインスタンス起動 → ボリュームアタッチ
#   4. 各ワーカーが割り当てモデルでgenerate-eval.py実行
#   5. 結果はS3に自動アップロード
#   6. 完了後ワーカーは自動終了
#
# Usage:
#   ./parallel-eval.sh                        # スナップショット→起動→生成
#   ./parallel-eval.sh --skip-snapshot SNAP_ID # 既存スナップショット使用
#   ./parallel-eval.sh --status               # 進捗確認
#   ./parallel-eval.sh --cleanup              # 全ワーカー終了+リソース削除
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REGION="us-east-1"
FALLBACK_INSTANCE_TYPE="g5.xlarge"
PREFERRED_INSTANCE_TYPE="g6e.xlarge"
NUM_WORKERS=13  # 1 model per worker (max parallelism, limit=64 vCPU=16 instances)
S3_BUCKET="r18-anime-assets"
STATE_FILE="/tmp/parallel-eval-state.json"

# Load .env
if [[ -f "${REPO_ROOT}/.env" ]]; then
    set -a; source "${REPO_ROOT}/.env"; set +a
fi

log() { echo "[$(date '+%H:%M:%S')] $*" >&2; }
err() { echo "[$(date '+%H:%M:%S')] ERROR: $*" >&2; }

# 13ワーカー: 1モデル1台（最大並列）
# GPU Spot limit = 64 vCPU, g5/g6e.xlarge = 4 vCPU → max 16台
WORKER_MODELS=(
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

WORKER_NAMES=(
    "wai-v16" "wai-v14" "wai-v12" "wai-v11" "rouwei"
    "illustrij" "nova" "autismmix" "pony" "animagine"
    "femix" "dreamshaper" "aam"
)

# Alternate AZs for Spot availability
WORKER_AZS=(
    "us-east-1c" "us-east-1d" "us-east-1c" "us-east-1d"
    "us-east-1c" "us-east-1d" "us-east-1c" "us-east-1d"
    "us-east-1c" "us-east-1d" "us-east-1c" "us-east-1d"
    "us-east-1c"
)

# AZ → Private Subnet mapping (bash 3.2 compatible, no declare -A)
SUBNET_C="subnet-0f157f0947d8bef8e"
SUBNET_D="subnet-06614586de12d6e08"
get_subnet_for_az() {
    case "$1" in
        us-east-1c) echo "${SUBNET_C}" ;;
        us-east-1d) echo "${SUBNET_D}" ;;
        *) echo "${PRIVATE_SUBNET_ID}" ;;
    esac
}

# =============================================================================
# Find source instance
# =============================================================================
find_source_instance() {
    aws ec2 describe-instances --region "${REGION}" \
        --filters "Name=tag:Name,Values=r18-anime-gpu" \
                  "Name=instance-state-name,Values=running" \
        --query 'Reservations[0].Instances[0].InstanceId' \
        --output text 2>/dev/null
}

# =============================================================================
# Step 1: Upload scripts and prompts to S3 (avoids git clone dependency)
# =============================================================================
upload_scripts_to_s3() {
    log "Uploading scripts and prompts to S3..."
    aws s3 cp "${REPO_ROOT}/scripts/generate-eval.py" \
        "s3://${S3_BUCKET}/eval-scripts/generate-eval.py" --region "${REGION}"
    aws s3 cp "${REPO_ROOT}/assets/templates/eval-prompts.json" \
        "s3://${S3_BUCKET}/eval-scripts/eval-prompts.json" --region "${REGION}"
    log "Scripts uploaded to s3://${S3_BUCKET}/eval-scripts/"
}

# =============================================================================
# Step 2: Create EBS snapshot from data volume
# =============================================================================
create_snapshot() {
    local vol_id="${EBS_VOLUME_ID}"
    local snap_name="r18-anime-eval-$(date +%Y%m%d-%H%M)"

    log "Creating snapshot from data volume ${vol_id}..."
    local snap_id
    snap_id=$(aws ec2 create-snapshot --region "${REGION}" \
        --volume-id "${vol_id}" \
        --description "${snap_name}: 13 models + ComfyUI + custom nodes" \
        --tag-specifications "ResourceType=snapshot,Tags=[{Key=Name,Value=${snap_name}},{Key=Purpose,Value=eval-batch}]" \
        --query 'SnapshotId' --output text)

    log "Snapshot: ${snap_id}"
    log "Waiting for snapshot to complete (200GB, may take 5-15 min)..."

    # Custom wait with longer timeout (max 30 min)
    for i in $(seq 1 90); do
        local state
        state=$(aws ec2 describe-snapshots --region "${REGION}" \
            --snapshot-ids "${snap_id}" \
            --query 'Snapshots[0].State' --output text 2>/dev/null)
        local progress
        progress=$(aws ec2 describe-snapshots --region "${REGION}" \
            --snapshot-ids "${snap_id}" \
            --query 'Snapshots[0].Progress' --output text 2>/dev/null)
        if [[ "${state}" == "completed" ]]; then
            log "Snapshot ready: ${snap_id}"
            echo "${snap_id}"
            return 0
        fi
        log "  Snapshot progress: ${progress} (${state})"
        sleep 20
    done
    err "Snapshot timed out after 30 minutes"
    exit 1
}

# =============================================================================
# Step 3: Create volume from snapshot in target AZ
# =============================================================================
create_volume_from_snapshot() {
    local snap_id="$1"
    local az="$2"
    local worker_name="$3"

    local vol_id
    vol_id=$(aws ec2 create-volume --region "${REGION}" \
        --availability-zone "${az}" \
        --snapshot-id "${snap_id}" \
        --volume-type gp3 \
        --encrypted \
        --tag-specifications "ResourceType=volume,Tags=[{Key=Name,Value=r18-eval-data-${worker_name}},{Key=Purpose,Value=eval-batch}]" \
        --query 'VolumeId' --output text)

    log "  Volume ${vol_id} created in ${az} from ${snap_id}"

    # Wait for available
    aws ec2 wait volume-available --region "${REGION}" --volume-ids "${vol_id}"
    echo "${vol_id}"
}

# =============================================================================
# Step 4: Launch a Spot worker and attach data volume
# =============================================================================
launch_worker() {
    local snap_id="$1"
    local worker_idx="$2"
    local models="${WORKER_MODELS[$worker_idx]}"
    local name="${WORKER_NAMES[$worker_idx]}"
    local az="${WORKER_AZS[$worker_idx]}"

    # Create data volume from snapshot
    local data_vol_id
    data_vol_id=$(create_volume_from_snapshot "${snap_id}" "${az}" "${name}")

    # Get the subnet for this AZ
    local subnet
    subnet=$(get_subnet_for_az "${az}")

    # Build UserData
    # NOTE: Single-quoted heredoc prevents expansion, then we do string replacement
    local userdata
    userdata=$(cat <<'USERDATA_EOF'
#!/bin/bash
exec > /var/log/eval-worker.log 2>&1

echo "=== Eval Worker Starting ==="
echo "Worker: __NAME__"
echo "Models: __MODELS__"
date -u

# --- Spot interruption handler ---
# AWS gives 2-min warning before termination
spot_handler() {
    echo "SPOT INTERRUPTION detected at $(date -u)"
    echo "interrupted $(date -u +%Y-%m-%dT%H:%M:%SZ)" | aws s3 cp - "s3://__S3_BUCKET__/eval-status/__NAME__-interrupted.txt" --region __REGION__
    # generate-eval.py already uploads per-prompt, so partial work is saved
    # Just kill ComfyUI cleanly
    kill $COMFYUI_PID 2>/dev/null || true
    exit 0
}
# Check for spot interruption in background (every 5s)
(while true; do
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "X-aws-ec2-metadata-token: $(curl -sX PUT 'http://169.254.169.254/latest/api/token' -H 'X-aws-ec2-metadata-token-ttl-seconds: 30' 2>/dev/null)" \
        http://169.254.169.254/latest/meta-data/spot/instance-action 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        spot_handler
    fi
    sleep 5
done) &
SPOT_MONITOR_PID=$!

# --- Mount data volume ---
# The data volume is attached as /dev/sdf (appears as /dev/nvme1n1 on nitro)
echo "Waiting for data volume device..."
for attempt in $(seq 1 30); do
    for dev in /dev/nvme1n1 /dev/xvdf /dev/sdf; do
        if [ -b "$dev" ]; then
            echo "Found device: $dev"
            mkdir -p /data
            mount "$dev" /data 2>/dev/null && echo "Mounted $dev on /data" && break 2
        fi
    done
    echo "  Waiting for device... ($attempt/30)"
    sleep 10
done

if ! mountpoint -q /data; then
    echo "ERROR: Could not mount /data after 5 minutes"
    # Try to self-terminate even on failure
    TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null || true)
    INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || true)
    [ -n "$INSTANCE_ID" ] && aws ec2 terminate-instances --region __REGION__ --instance-ids "$INSTANCE_ID" 2>/dev/null || true
    exit 1
fi

# --- Install boto3 and Pillow if missing ---
if ! python3 -c "import boto3" 2>/dev/null; then
    echo "Installing boto3..."
    pip3 install boto3 2>/dev/null || true
fi
if ! python3 -c "from PIL import Image" 2>/dev/null; then
    echo "Installing Pillow (for thumbnails)..."
    pip3 install Pillow 2>/dev/null || true
fi
# Also install in ComfyUI venv
if [ -d /data/ComfyUI/venv ]; then
    /data/ComfyUI/venv/bin/pip install boto3 Pillow 2>/dev/null || true
fi

# --- Start ComfyUI ---
cd /data/ComfyUI
source venv/bin/activate
python main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch &
COMFYUI_PID=$!

echo "Waiting for ComfyUI..."
COMFYUI_READY=false
for i in $(seq 1 90); do
    if curl -s http://127.0.0.1:8188/system_stats > /dev/null 2>&1; then
        echo "ComfyUI ready after ${i}x5s"
        COMFYUI_READY=true
        break
    fi
    sleep 5
done

if [ "$COMFYUI_READY" != "true" ]; then
    echo "ERROR: ComfyUI did not start within 7.5 minutes"
    kill $COMFYUI_PID 2>/dev/null || true
    TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null || true)
    INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || true)
    [ -n "$INSTANCE_ID" ] && aws ec2 terminate-instances --region __REGION__ --instance-ids "$INSTANCE_ID" 2>/dev/null || true
    exit 1
fi

# --- Download scripts from S3 (no git clone needed) ---
mkdir -p /tmp/eval-work/scripts /tmp/eval-work/assets/templates
aws s3 cp "s3://__S3_BUCKET__/eval-scripts/generate-eval.py" /tmp/eval-work/scripts/generate-eval.py --region __REGION__
aws s3 cp "s3://__S3_BUCKET__/eval-scripts/eval-prompts.json" /tmp/eval-work/assets/templates/eval-prompts.json --region __REGION__

# --- Run generation ---
echo "Starting generation: __MODELS__"
cd /tmp/eval-work
COMFYUI_URL=http://127.0.0.1:8188 \
S3_BUCKET=__S3_BUCKET__ \
python3 scripts/generate-eval.py --models "__MODELS__" 2>&1 || {
    echo "ERROR: generate-eval.py failed with exit code $?"
}

echo "=== Generation complete ==="
date -u

# --- Stop monitoring and ComfyUI ---
kill $SPOT_MONITOR_PID 2>/dev/null || true
kill $COMFYUI_PID 2>/dev/null || true

# --- Signal completion ---
echo "done $(date -u +%Y-%m-%dT%H:%M:%SZ)" | aws s3 cp - "s3://__S3_BUCKET__/eval-status/__NAME__-done.txt" --region __REGION__

# --- Self-terminate (IMDSv2) ---
echo "Self-terminating..."
TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null || true)
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || true)
if [ -n "$INSTANCE_ID" ]; then
    aws ec2 terminate-instances --region __REGION__ --instance-ids "$INSTANCE_ID"
else
    echo "WARNING: Could not get instance ID for self-termination"
    shutdown -h now
fi
USERDATA_EOF
)

    # Replace placeholders
    userdata="${userdata//__MODELS__/$models}"
    userdata="${userdata//__MODELS__/$models}"
    userdata="${userdata//__NAME__/$name}"
    userdata="${userdata//__S3_BUCKET__/$S3_BUCKET}"
    userdata="${userdata//__REGION__/$REGION}"
    userdata="${userdata//__REGION__/$REGION}"
    userdata="${userdata//__REGION__/$REGION}"
    userdata="${userdata//__REGION__/$REGION}"

    local encoded_userdata
    encoded_userdata=$(echo "$userdata" | base64)

    # Launch instance — try g6e first, fallback to g5
    local actual_type="${PREFERRED_INSTANCE_TYPE}"
    local instance_id
    local sg="${SG_ID}"

    log "  Launching worker ${name} (${actual_type} spot, ${az})..."

    instance_id=$(aws ec2 run-instances --region "${REGION}" \
        --image-id "${AMI_ID}" \
        --instance-type "${actual_type}" \
        --placement "AvailabilityZone=${az}" \
        --subnet-id "${subnet}" \
        --security-group-ids "${sg}" \
        --iam-instance-profile "Name=r18-anime-instance-profile" \
        --instance-market-options '{"MarketType":"spot","SpotOptions":{"SpotInstanceType":"one-time"}}' \
        --user-data "${encoded_userdata}" \
        --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=r18-eval-${name}},{Key=Purpose,Value=eval-batch}]" \
        --query 'Instances[0].InstanceId' --output text 2>/dev/null) || true

    if [[ -z "${instance_id}" || "${instance_id}" == "None" ]]; then
        log "    g6e spot unavailable in ${az}, trying g5..."
        actual_type="${FALLBACK_INSTANCE_TYPE}"
        instance_id=$(aws ec2 run-instances --region "${REGION}" \
            --image-id "${AMI_ID}" \
            --instance-type "${actual_type}" \
            --placement "AvailabilityZone=${az}" \
            --subnet-id "${subnet}" \
            --security-group-ids "${sg}" \
            --iam-instance-profile "Name=r18-anime-instance-profile" \
            --instance-market-options '{"MarketType":"spot","SpotOptions":{"SpotInstanceType":"one-time"}}' \
            --user-data "${encoded_userdata}" \
            --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=r18-eval-${name}},{Key=Purpose,Value=eval-batch}]" \
            --query 'Instances[0].InstanceId' --output text)
    fi

    if [[ -z "${instance_id}" || "${instance_id}" == "None" ]]; then
        err "Failed to launch worker ${name}"
        return 1
    fi

    # Wait for running
    log "    Waiting for ${instance_id} to start..."
    aws ec2 wait instance-running --region "${REGION}" --instance-ids "${instance_id}"

    # Attach data volume
    log "    Attaching data volume ${data_vol_id}..."
    aws ec2 attach-volume --region "${REGION}" \
        --volume-id "${data_vol_id}" \
        --instance-id "${instance_id}" \
        --device /dev/sdf >/dev/null

    log "  Worker ${name}: ${instance_id} (${actual_type}, ${az})"
    echo "${instance_id}:${data_vol_id}"
}

# =============================================================================
# Check progress
# =============================================================================
check_progress() {
    log "=== Progress ==="

    for name in "${WORKER_NAMES[@]}"; do
        local done_marker interrupted_marker
        done_marker=$(aws s3 ls "s3://${S3_BUCKET}/eval-status/${name}-done.txt" --region "${REGION}" 2>/dev/null || true)
        interrupted_marker=$(aws s3 ls "s3://${S3_BUCKET}/eval-status/${name}-interrupted.txt" --region "${REGION}" 2>/dev/null || true)
        if [[ -n "$done_marker" ]]; then
            log "  ${name}: DONE"
        elif [[ -n "$interrupted_marker" ]]; then
            log "  ${name}: INTERRUPTED (Spot terminated — re-run to resume)"
        else
            log "  ${name}: running"
        fi
    done

    # Count images in S3
    local image_count
    image_count=$(aws s3 ls "s3://${S3_BUCKET}/gallery/experiments/$(date +%Y%m%d)_" \
        --region "${REGION}" --recursive 2>/dev/null | grep -c "\.png$" || echo 0)
    log "  Images in S3: ${image_count} / 6435"

    # Running workers
    local running
    running=$(aws ec2 describe-instances --region "${REGION}" \
        --filters "Name=tag:Purpose,Values=eval-batch" \
                  "Name=instance-state-name,Values=running,pending" \
        --query 'Reservations[].Instances[].[InstanceId,InstanceType,Tags[?Key==`Name`].Value|[0]]' \
        --output text 2>/dev/null || true)
    if [[ -n "$running" && "$running" != "None" ]]; then
        log "  Running workers:"
        echo "$running" | while IFS=$'\t' read -r id type tag; do
            log "    ${tag}: ${id} (${type})"
        done
    else
        log "  No workers running"
    fi
}

# =============================================================================
# Cleanup
# =============================================================================
cleanup() {
    log "=== Cleanup ==="

    # Terminate eval workers
    local worker_ids
    worker_ids=$(aws ec2 describe-instances --region "${REGION}" \
        --filters "Name=tag:Purpose,Values=eval-batch" \
                  "Name=instance-state-name,Values=running,pending,stopping,stopped" \
        --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null || true)

    if [[ -n "$worker_ids" && "$worker_ids" != "None" ]]; then
        log "Terminating workers: ${worker_ids}"
        # shellcheck disable=SC2086
        aws ec2 terminate-instances --region "${REGION}" --instance-ids ${worker_ids} >/dev/null
        log "Waiting for termination..."
        # shellcheck disable=SC2086
        aws ec2 wait instance-terminated --region "${REGION}" --instance-ids ${worker_ids} 2>/dev/null || true
    fi

    # Delete eval data volumes
    local eval_vols
    eval_vols=$(aws ec2 describe-volumes --region "${REGION}" \
        --filters "Name=tag:Purpose,Values=eval-batch" \
        --query 'Volumes[].VolumeId' --output text 2>/dev/null || true)
    if [[ -n "$eval_vols" && "$eval_vols" != "None" ]]; then
        for vol in ${eval_vols}; do
            log "  Deleting volume: ${vol}"
            aws ec2 delete-volume --region "${REGION}" --volume-id "${vol}" 2>/dev/null || true
        done
    fi

    # Delete eval snapshots
    local eval_snaps
    eval_snaps=$(aws ec2 describe-snapshots --region "${REGION}" --owner-ids self \
        --filters "Name=tag:Purpose,Values=eval-batch" \
        --query 'Snapshots[].SnapshotId' --output text 2>/dev/null || true)
    if [[ -n "$eval_snaps" && "$eval_snaps" != "None" ]]; then
        for snap in ${eval_snaps}; do
            log "  Deleting snapshot: ${snap}"
            aws ec2 delete-snapshot --region "${REGION}" --snapshot-id "${snap}" 2>/dev/null || true
        done
    fi

    # Clean up S3 status markers and scripts
    aws s3 rm "s3://${S3_BUCKET}/eval-status/" --recursive --region "${REGION}" 2>/dev/null || true
    aws s3 rm "s3://${S3_BUCKET}/eval-scripts/" --recursive --region "${REGION}" 2>/dev/null || true

    log "Cleanup complete"
}

# =============================================================================
# Main
# =============================================================================
main() {
    local skip_snapshot=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --skip-snapshot) skip_snapshot="$2"; shift 2 ;;
            --status) check_progress; exit 0 ;;
            --cleanup) cleanup; exit 0 ;;
            -h|--help)
                echo "Usage: $0 [--skip-snapshot SNAP_ID] [--status] [--cleanup]"
                exit 0 ;;
            *) err "Unknown: $1"; exit 1 ;;
        esac
    done

    # Step 0: Find source instance and get AMI
    local source_id
    source_id=$(find_source_instance)
    if [[ -z "$source_id" || "$source_id" == "None" ]]; then
        err "No running r18-anime-gpu instance found"
        exit 1
    fi
    log "Source instance: ${source_id}"

    # Get the AMI used by the source instance (reuse it for workers)
    AMI_ID=$(aws ec2 describe-instances --region "${REGION}" \
        --instance-ids "${source_id}" \
        --query 'Reservations[0].Instances[0].ImageId' --output text)
    log "Source AMI: ${AMI_ID}"

    # Step 1: Upload scripts to S3
    upload_scripts_to_s3

    # Step 2: Create snapshot (or reuse)
    local snap_id
    if [[ -n "$skip_snapshot" ]]; then
        snap_id="$skip_snapshot"
        log "Using existing snapshot: ${snap_id}"
    else
        snap_id=$(create_snapshot)
    fi

    # Step 3: Launch workers
    log "Launching ${NUM_WORKERS} workers..."
    local worker_info=()
    for i in $(seq 0 $((NUM_WORKERS - 1))); do
        local info
        info=$(launch_worker "${snap_id}" "$i")
        worker_info+=("$info")
    done

    # Save state
    cat > "${STATE_FILE}" << STATEOF
{
    "snapshot_id": "${snap_id}",
    "ami_id": "${AMI_ID}",
    "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "workers": [
$(for i in $(seq 0 $((NUM_WORKERS - 1))); do
    local iid="${worker_info[$i]%%:*}"
    local vid="${worker_info[$i]##*:}"
    printf '        {"name": "%s", "instance_id": "%s", "volume_id": "%s", "models": "%s"}' \
        "${WORKER_NAMES[$i]}" "$iid" "$vid" "${WORKER_MODELS[$i]}"
    [[ $i -lt $((NUM_WORKERS - 1)) ]] && echo ","
done)
    ]
}
STATEOF

    log ""
    log "============================================================"
    log "  Parallel eval started"
    log "============================================================"
    log "  Snapshot: ${snap_id}"
    log "  AMI:      ${AMI_ID}"
    log "  Workers:  ${NUM_WORKERS}"
    for i in $(seq 0 $((NUM_WORKERS - 1))); do
        local iid="${worker_info[$i]%%:*}"
        log "    ${WORKER_NAMES[$i]}: ${iid} (${WORKER_AZS[$i]})"
        log "      models: ${WORKER_MODELS[$i]}"
    done
    log "------------------------------------------------------------"
    log "  Monitor:  $0 --status"
    log "  Cleanup:  $0 --cleanup"
    log "  Workers self-terminate on completion"
    log "  Cost: ~\$5 (4x Spot × ~1.5h)"
    log "============================================================"
}

main "$@"
