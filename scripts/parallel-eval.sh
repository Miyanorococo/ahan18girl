#!/bin/bash
set -euo pipefail

# =============================================================================
# parallel-eval.sh - 13モデル比較画像をSpot並列生成 (EC2 Fleet版)
#
# EC2 Fleet API + capacity-optimized Spot + BlockDeviceMapping で:
#   - 全5AZ × 複数インスタンスタイプから最適Spot配置
#   - データボリュームはBlockDeviceMappingで自動アタッチ（AZ制約なし）
#   - DeleteOnTerminationで孤立ボリューム防止
#   - UserDataはタグからモデル名を取得（テンプレート1つで全ワーカー対応）
#
# Usage:
#   ./parallel-eval.sh                        # スナップショット→Fleet起動→生成
#   ./parallel-eval.sh --skip-snapshot SNAP_ID # 既存スナップショット使用
#   ./parallel-eval.sh --ami AMI_ID           # AMI直接指定
#   ./parallel-eval.sh --prefer-g5            # g5.xlarge限定（g6e Spot不安定時）
#   ./parallel-eval.sh --status               # 進捗確認
#   ./parallel-eval.sh --cleanup              # 全ワーカー終了+リソース削除
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REGION="us-east-1"
S3_BUCKET="r18-anime-assets"
STATE_FILE="/tmp/parallel-eval-state.json"

# Instance types for Spot (g6 family, fastest first, multiple pools for availability)
SPOT_INSTANCE_TYPES=("g6e.xlarge" "g6e.2xlarge" "g6.xlarge" "g6.2xlarge")
# On-Demand fallback (fastest single type, used only when Spot unavailable)
OD_INSTANCE_TYPE="g6e.xlarge"

# All private subnets (5 AZs)
SUBNETS=(
    "subnet-056261462869cbfa2"  # us-east-1a
    "subnet-019606bc955539fbe"  # us-east-1b
    "subnet-0f157f0947d8bef8e"  # us-east-1c
    "subnet-06614586de12d6e08"  # us-east-1d
    "subnet-034d901aa43c8b856"  # us-east-1f
)

# 13 models × 1 worker each
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

NUM_WORKERS=${#WORKER_MODELS[@]}

# Load .env
if [[ -f "${REPO_ROOT}/.env" ]]; then
    set -a; source "${REPO_ROOT}/.env"; set +a
fi

log() { echo "[$(date '+%H:%M:%S')] $*" >&2; }
err() { echo "[$(date '+%H:%M:%S')] ERROR: $*" >&2; }

# =============================================================================
# Upload scripts to S3
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
# Create EBS snapshot from data volume
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

    for i in $(seq 1 90); do
        local state progress
        state=$(aws ec2 describe-snapshots --region "${REGION}" \
            --snapshot-ids "${snap_id}" \
            --query 'Snapshots[0].State' --output text 2>/dev/null)
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
# Create Launch Template with generic UserData
# =============================================================================
create_launch_template() {
    local ami_id="$1"
    local snap_id="$2"
    local sg="${SG_ID}"
    local template_name="r18-eval-$(date +%Y%m%d%H%M%S)"

    # Write UserData to temp file
    local userdata_file="/tmp/eval-userdata-generic.sh"
    cat > "${userdata_file}" << 'USERDATA_EOF'
#!/bin/bash
exec > /var/log/eval-worker.log 2>&1

REGION="us-east-1"
S3_BUCKET="r18-anime-assets"

echo "=== Eval Worker Starting ==="
date -u

# --- Get instance metadata (IMDSv2) ---
TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null)
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
    http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null)
echo "Instance: ${INSTANCE_ID}"

# --- Read model assignment from instance tag ---
# Retry up to 30s (tags may take a moment to propagate)
MODELS=""
WORKER_NAME=""
for i in $(seq 1 6); do
    MODELS=$(aws ec2 describe-tags --region ${REGION} \
        --filters "Name=resource-id,Values=${INSTANCE_ID}" "Name=key,Values=EvalModel" \
        --query 'Tags[0].Value' --output text 2>/dev/null || true)
    WORKER_NAME=$(aws ec2 describe-tags --region ${REGION} \
        --filters "Name=resource-id,Values=${INSTANCE_ID}" "Name=key,Values=EvalWorker" \
        --query 'Tags[0].Value' --output text 2>/dev/null || true)
    if [[ -n "$MODELS" && "$MODELS" != "None" ]]; then
        break
    fi
    echo "  Waiting for tags... ($i/6)"
    sleep 5
done

if [[ -z "$MODELS" || "$MODELS" == "None" ]]; then
    echo "ERROR: Could not read EvalModel tag"
    aws ec2 terminate-instances --region ${REGION} --instance-ids "${INSTANCE_ID}" 2>/dev/null || true
    exit 1
fi

echo "Worker: ${WORKER_NAME}"
echo "Models: ${MODELS}"

# --- Spot interruption handler ---
(while true; do
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "X-aws-ec2-metadata-token: $(curl -sX PUT 'http://169.254.169.254/latest/api/token' -H 'X-aws-ec2-metadata-token-ttl-seconds: 30' 2>/dev/null)" \
        http://169.254.169.254/latest/meta-data/spot/instance-action 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ]; then
        echo "SPOT INTERRUPTION detected at $(date -u)"
        echo "interrupted $(date -u +%Y-%m-%dT%H:%M:%SZ)" | \
            aws s3 cp - "s3://${S3_BUCKET}/eval-status/${WORKER_NAME}-interrupted.txt" --region ${REGION}
        kill $COMFYUI_PID 2>/dev/null || true
        exit 0
    fi
    sleep 5
done) &
SPOT_MONITOR_PID=$!

# --- Mount data volume ---
# BlockDeviceMapping attaches it as /dev/sdf (appears as /dev/nvme1n1 on nitro)
echo "Waiting for data volume..."
for attempt in $(seq 1 30); do
    for dev in /dev/nvme1n1 /dev/xvdf /dev/sdf; do
        if [ -b "$dev" ]; then
            mkdir -p /data
            mount "$dev" /data 2>/dev/null && echo "Mounted $dev on /data" && break 2
        fi
    done
    echo "  Waiting for device... ($attempt/30)"
    sleep 10
done

if ! mountpoint -q /data; then
    echo "ERROR: Could not mount /data after 5 minutes"
    kill $SPOT_MONITOR_PID 2>/dev/null || true
    aws ec2 terminate-instances --region ${REGION} --instance-ids "${INSTANCE_ID}" 2>/dev/null || true
    exit 1
fi

# --- Install dependencies ---
pip3 install boto3 Pillow 2>/dev/null || true
if [ -d /data/ComfyUI/venv ]; then
    /data/ComfyUI/venv/bin/pip install boto3 Pillow 2>/dev/null || true
fi

# --- Ensure clean CUDA context (kill any existing ComfyUI) ---
systemctl stop comfyui 2>/dev/null || true
pkill -f "main.py.*8188" 2>/dev/null || true
sleep 5

# --- Wait for EBS snapshot initialization ---
echo "Waiting for EBS initialization..."
sleep 15

# --- Start ComfyUI ---
cd /data/ComfyUI
source venv/bin/activate
python main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch --gpu-only &
COMFYUI_PID=$!

echo "Waiting for ComfyUI..."
COMFYUI_READY=false
for i in $(seq 1 90); do
    if curl -s http://127.0.0.1:8188/system_stats > /dev/null 2>&1; then
        # Also verify KSampler node is available (custom nodes fully loaded)
        if curl -s http://127.0.0.1:8188/object_info/KSampler 2>/dev/null | grep -q "KSampler"; then
            echo "ComfyUI + KSampler ready after ${i}x5s"
            COMFYUI_READY=true
            break
        else
            echo "  HTTP up but KSampler not yet loaded (${i}x5s)"
        fi
    fi
    sleep 5
done

if [ "$COMFYUI_READY" != "true" ]; then
    echo "ERROR: ComfyUI did not start within 7.5 minutes"
    kill $COMFYUI_PID 2>/dev/null || true
    kill $SPOT_MONITOR_PID 2>/dev/null || true
    aws ec2 terminate-instances --region ${REGION} --instance-ids "${INSTANCE_ID}" 2>/dev/null || true
    exit 1
fi

# --- Download scripts from S3 ---
mkdir -p /tmp/eval-work/scripts /tmp/eval-work/assets/templates
aws s3 cp "s3://${S3_BUCKET}/eval-scripts/generate-eval.py" /tmp/eval-work/scripts/ --region ${REGION}
aws s3 cp "s3://${S3_BUCKET}/eval-scripts/eval-prompts.json" /tmp/eval-work/assets/templates/ --region ${REGION}

# --- Run generation ---
echo "Starting generation: ${MODELS}"
cd /tmp/eval-work
COMFYUI_URL=http://127.0.0.1:8188 \
S3_BUCKET=${S3_BUCKET} \
python3 scripts/generate-eval.py --models "${MODELS}" 2>&1 || {
    echo "ERROR: generate-eval.py failed with exit code $?"
}

echo "=== Generation complete ==="
date -u

# --- Cleanup ---
kill $SPOT_MONITOR_PID 2>/dev/null || true
kill $COMFYUI_PID 2>/dev/null || true

# --- Signal completion ---
echo "done $(date -u +%Y-%m-%dT%H:%M:%SZ)" | \
    aws s3 cp - "s3://${S3_BUCKET}/eval-status/${WORKER_NAME}-done.txt" --region ${REGION}

# --- Self-terminate ---
echo "Self-terminating..."
aws ec2 terminate-instances --region ${REGION} --instance-ids "${INSTANCE_ID}"
USERDATA_EOF

    # Base64 encode for launch template (LaunchTemplateData requires base64)
    # Use -b 0 (macOS) or -w 0 (Linux) to avoid line wrapping in JSON
    local userdata_b64
    if base64 --help 2>&1 | grep -q '\-w'; then
        userdata_b64=$(base64 -w 0 < "${userdata_file}")
    else
        userdata_b64=$(base64 -b 0 < "${userdata_file}")
    fi

    # Build BlockDeviceMapping JSON: override AMI's /dev/xvdf with newer snapshot
    # The AMI already has /dev/xvdf (data volume). We override it with our snapshot.
    # On Nitro instances, this appears as /dev/nvme1n1 (root is /dev/nvme0n1).
    local bdm_json
    bdm_json=$(cat << BDMEOF
[
    {
        "DeviceName": "/dev/xvdf",
        "Ebs": {
            "SnapshotId": "${snap_id}",
            "VolumeSize": 200,
            "VolumeType": "gp3",
            "Encrypted": true,
            "DeleteOnTermination": true
        }
    }
]
BDMEOF
)

    # Create launch template
    local template_id
    template_id=$(aws ec2 create-launch-template --region "${REGION}" \
        --launch-template-name "${template_name}" \
        --launch-template-data "{
            \"ImageId\": \"${ami_id}\",
            \"SecurityGroupIds\": [\"${sg}\"],
            \"IamInstanceProfile\": {\"Name\": \"r18-anime-instance-profile\"},
            \"UserData\": \"${userdata_b64}\",
            \"BlockDeviceMappings\": ${bdm_json},
            \"TagSpecifications\": [{
                \"ResourceType\": \"instance\",
                \"Tags\": [{\"Key\": \"Purpose\", \"Value\": \"eval-batch\"}]
            }, {
                \"ResourceType\": \"volume\",
                \"Tags\": [{\"Key\": \"Purpose\", \"Value\": \"eval-batch\"}]
            }]
        }" \
        --query 'LaunchTemplate.LaunchTemplateId' --output text 2>&1)

    if [[ -z "${template_id}" || "${template_id}" == *"error"* || "${template_id}" == *"Error"* ]]; then
        err "Failed to create launch template: ${template_id}"
        exit 1
    fi

    log "Launch template: ${template_id} (${template_name})"
    echo "${template_id}:${template_name}"
}

# =============================================================================
# Extract instance ID from Fleet API JSON response
# =============================================================================
extract_fleet_instance_id() {
    python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    instances = data.get('Instances', [])
    if instances and instances[0].get('InstanceIds'):
        print(instances[0]['InstanceIds'][0])
    else:
        print('')
except:
    print('')
"
}

# =============================================================================
# Launch a worker: Spot (g6 multi-type) → On-Demand fallback
#
# Strategy:
#   1. EC2 Fleet capacity-optimized Spot across g6e/g6 × all AZs
#   2. If Spot unavailable → On-Demand g6e.xlarge (fastest guaranteed)
#
# Break-even: Spot is cheaper unless interrupted 5+ times per 1.5h job.
# Since generate-eval.py saves progress per-prompt, interruptions only
# waste ~15min startup overhead. Always prefer Spot.
# =============================================================================
launch_worker_fleet() {
    local template_id="$1"
    local worker_idx="$2"
    local models="${WORKER_MODELS[$worker_idx]}"
    local name="${WORKER_NAMES[$worker_idx]}"

    # --- Attempt 1: Spot (g6 multi-type × all AZs) ---
    local fleet_result instance_id=""

    # --- Attempt 1: Spot (skip if SPOT_INSTANCE_TYPES is empty, e.g. forced OD) ---
    if [[ ${#SPOT_INSTANCE_TYPES[@]} -gt 0 ]]; then
        local overrides="["
        local first=true
        for itype in "${SPOT_INSTANCE_TYPES[@]}"; do
            for subnet in "${SUBNETS[@]}"; do
                [[ "$first" == "true" ]] && first=false || overrides+=","
                overrides+="{\"InstanceType\":\"${itype}\",\"SubnetId\":\"${subnet}\"}"
            done
        done
        overrides+="]"

        log "  [${name}] Trying Spot (${SPOT_INSTANCE_TYPES[*]})..."

        fleet_result=$(aws ec2 create-fleet --region "${REGION}" \
        --type instant \
        --target-capacity-specification "TotalTargetCapacity=1,DefaultTargetCapacityType=spot" \
        --spot-options '{"AllocationStrategy":"capacity-optimized","InstanceInterruptionBehavior":"terminate"}' \
        --launch-template-configs "[{
            \"LaunchTemplateSpecification\": {
                \"LaunchTemplateId\": \"${template_id}\",
                \"Version\": \"\$Latest\"
            },
            \"Overrides\": ${overrides}
        }]" \
        --tag-specifications "ResourceType=fleet,Tags=[{Key=Name,Value=r18-eval-fleet-${name}},{Key=Purpose,Value=eval-batch}]" \
        2>&1)

        instance_id=$(echo "${fleet_result}" | extract_fleet_instance_id)
    fi  # end Spot attempt

    # --- Attempt 2: On-Demand fallback ---
    if [[ -z "${instance_id}" ]]; then
        log "  [${name}] Spot unavailable, falling back to On-Demand ${OD_INSTANCE_TYPE}..."

        local od_overrides="["
        first=true
        for subnet in "${SUBNETS[@]}"; do
            [[ "$first" == "true" ]] && first=false || od_overrides+=","
            od_overrides+="{\"InstanceType\":\"${OD_INSTANCE_TYPE}\",\"SubnetId\":\"${subnet}\"}"
        done
        od_overrides+="]"

        fleet_result=$(aws ec2 create-fleet --region "${REGION}" \
            --type instant \
            --target-capacity-specification "TotalTargetCapacity=1,DefaultTargetCapacityType=on-demand" \
            --on-demand-options '{"AllocationStrategy":"lowest-price"}' \
            --launch-template-configs "[{
                \"LaunchTemplateSpecification\": {
                    \"LaunchTemplateId\": \"${template_id}\",
                    \"Version\": \"\$Latest\"
                },
                \"Overrides\": ${od_overrides}
            }]" \
            --tag-specifications "ResourceType=fleet,Tags=[{Key=Name,Value=r18-eval-fleet-${name}},{Key=Purpose,Value=eval-batch}]" \
            2>&1)

        instance_id=$(echo "${fleet_result}" | extract_fleet_instance_id)
    fi

    if [[ -z "${instance_id}" ]]; then
        err "Failed to launch ${name} (both Spot and On-Demand failed)"
        return 1
    fi

    # Tag instance with model assignment + pricing type
    local lifecycle
    lifecycle=$(aws ec2 describe-instances --region "${REGION}" --instance-ids "${instance_id}" \
        --query 'Reservations[0].Instances[0].InstanceLifecycle' --output text 2>/dev/null)
    local pricing="on-demand"
    [[ "${lifecycle}" == "spot" ]] && pricing="spot"

    aws ec2 create-tags --region "${REGION}" --resources "${instance_id}" \
        --tags "Key=Name,Value=r18-eval-${name}" \
               "Key=EvalModel,Value=${models}" \
               "Key=EvalWorker,Value=${name}" \
               "Key=Purpose,Value=eval-batch" \
               "Key=Pricing,Value=${pricing}"

    # Get instance details
    local itype az
    itype=$(aws ec2 describe-instances --region "${REGION}" --instance-ids "${instance_id}" \
        --query 'Reservations[0].Instances[0].InstanceType' --output text 2>/dev/null)
    az=$(aws ec2 describe-instances --region "${REGION}" --instance-ids "${instance_id}" \
        --query 'Reservations[0].Instances[0].Placement.AvailabilityZone' --output text 2>/dev/null)

    log "  [${name}] ${instance_id} (${itype}, ${az}, ${pricing})"
    echo "${instance_id}"
}

# =============================================================================
# Check progress
# =============================================================================
check_progress() {
    log "=== Progress ==="

    local done_count=0
    local interrupted_count=0
    local running_count=0

    for name in "${WORKER_NAMES[@]}"; do
        local done_marker interrupted_marker
        done_marker=$(aws s3 ls "s3://${S3_BUCKET}/eval-status/${name}-done.txt" --region "${REGION}" 2>/dev/null || true)
        interrupted_marker=$(aws s3 ls "s3://${S3_BUCKET}/eval-status/${name}-interrupted.txt" --region "${REGION}" 2>/dev/null || true)
        if [[ -n "$done_marker" ]]; then
            log "  ${name}: ✅ DONE"
            done_count=$((done_count + 1))
        elif [[ -n "$interrupted_marker" ]]; then
            log "  ${name}: ⚠️  INTERRUPTED"
            interrupted_count=$((interrupted_count + 1))
        else
            log "  ${name}: 🔄 running"
            running_count=$((running_count + 1))
        fi
    done

    # Count images in S3
    local image_count
    image_count=$(aws s3 ls "s3://${S3_BUCKET}/gallery/experiments/" \
        --region "${REGION}" --recursive 2>/dev/null | grep -c "/full/.*\.png$" || echo 0)
    log ""
    log "  Summary: ${done_count} done, ${running_count} running, ${interrupted_count} interrupted"
    log "  Images in S3: ${image_count} / 7150"

    # Running workers
    local running
    running=$(aws ec2 describe-instances --region "${REGION}" \
        --filters "Name=tag:Purpose,Values=eval-batch" \
                  "Name=instance-state-name,Values=running,pending" \
        --query 'Reservations[].Instances[].[InstanceId,InstanceType,Tags[?Key==`Name`].Value|[0],Placement.AvailabilityZone]' \
        --output text 2>/dev/null || true)
    if [[ -n "$running" && "$running" != "None" ]]; then
        log ""
        log "  Active instances:"
        local spot_count=0 od_count=0
        running=$(aws ec2 describe-instances --region "${REGION}" \
            --filters "Name=tag:Purpose,Values=eval-batch" \
                      "Name=instance-state-name,Values=running,pending" \
            --query 'Reservations[].Instances[].[InstanceId,InstanceType,Tags[?Key==`Name`].Value|[0],Placement.AvailabilityZone,InstanceLifecycle]' \
            --output text 2>/dev/null || true)
        echo "$running" | while IFS=$'\t' read -r id itype tag az lifecycle; do
            local pricing="OD"
            [[ "${lifecycle}" == "spot" ]] && pricing="Spot"
            log "    ${tag}: ${id} (${itype}, ${az}, ${pricing})"
        done
    else
        log "  No instances running"
    fi

    # Cost estimate
    if [[ $done_count -eq ${NUM_WORKERS} ]]; then
        log ""
        log "  🎉 All workers complete! Run: $0 --cleanup"
    fi
}

# =============================================================================
# Watch mode: auto-retry interrupted workers
#
# - Checks every WATCH_INTERVAL seconds
# - INTERRUPTED → clear marker → relaunch via Fleet
# - Per-worker retry limit (MAX_RETRIES). Beyond that → force On-Demand
# - generate-eval.py auto-resumes from S3 (skips completed prompts)
# - Exits when all workers are DONE
# =============================================================================
WATCH_INTERVAL=120  # seconds between checks
MAX_RETRIES=5       # per worker; matches Spot/OD break-even point

# Retry counters stored in /tmp files (compatible with bash 3.x on macOS)
RETRY_DIR="/tmp/parallel-eval-retries"
mkdir -p "${RETRY_DIR}" 2>/dev/null || true

get_worker_index() {
    local target="$1"
    for i in $(seq 0 $((NUM_WORKERS - 1))); do
        [[ "${WORKER_NAMES[$i]}" == "${target}" ]] && echo "$i" && return
    done
    echo "-1"
}

relaunch_worker() {
    local template_id="$1"
    local name="$2"
    local idx
    idx=$(get_worker_index "${name}")
    if [[ "$idx" == "-1" ]]; then
        err "Unknown worker: ${name}"
        return 1
    fi

    local retries=0
    if [[ -f "${RETRY_DIR}/${name}" ]]; then
        retries=$(cat "${RETRY_DIR}/${name}")
    fi
    retries=$((retries + 1))
    echo "${retries}" > "${RETRY_DIR}/${name}"

    # Clear interrupted marker
    aws s3 rm "s3://${S3_BUCKET}/eval-status/${name}-interrupted.txt" --region "${REGION}" 2>/dev/null || true

    if [[ $retries -gt $MAX_RETRIES ]]; then
        log "  [${name}] Retry ${retries}/${MAX_RETRIES} exceeded → forcing On-Demand"
        # Temporarily override to OD-only
        local saved_spot=("${SPOT_INSTANCE_TYPES[@]}")
        SPOT_INSTANCE_TYPES=()  # empty = skip Spot attempt
        launch_worker_fleet "${template_id}" "$idx" || true
        SPOT_INSTANCE_TYPES=("${saved_spot[@]}")
    else
        log "  [${name}] Retry ${retries}/${MAX_RETRIES} (Spot, generate-eval.py will auto-resume)"
        launch_worker_fleet "${template_id}" "$idx" || true
    fi
}

watch_and_retry() {
    local template_id="$1"

    log ""
    log "=== Watch mode started (interval=${WATCH_INTERVAL}s, max_retries=${MAX_RETRIES}) ==="
    log "  Ctrl+C to stop watching (workers continue running)"
    log ""

    while true; do
        local done_count=0
        local interrupted_workers=()

        for name in "${WORKER_NAMES[@]}"; do
            local done_marker interrupted_marker
            done_marker=$(aws s3 ls "s3://${S3_BUCKET}/eval-status/${name}-done.txt" --region "${REGION}" 2>/dev/null || true)
            interrupted_marker=$(aws s3 ls "s3://${S3_BUCKET}/eval-status/${name}-interrupted.txt" --region "${REGION}" 2>/dev/null || true)
            if [[ -n "$done_marker" ]]; then
                done_count=$((done_count + 1))
            elif [[ -n "$interrupted_marker" ]]; then
                interrupted_workers+=("$name")
            fi
        done

        # All done?
        if [[ $done_count -eq ${NUM_WORKERS} ]]; then
            log "🎉 All ${NUM_WORKERS} workers complete!"
            # Show image count
            local image_count
            image_count=$(aws s3 ls "s3://${S3_BUCKET}/gallery/experiments/" \
                --region "${REGION}" --recursive 2>/dev/null | grep -c "/full/.*\.png$" || echo 0)
            log "  Images in S3: ${image_count} / 7150"
            log "  Next: ./parallel-eval.sh --cleanup"
            return 0
        fi

        # Relaunch interrupted workers
        if [[ ${#interrupted_workers[@]} -gt 0 ]]; then
            log "[$(date '+%H:%M:%S')] Detected ${#interrupted_workers[@]} interrupted worker(s): ${interrupted_workers[*]}"
            for name in "${interrupted_workers[@]}"; do
                relaunch_worker "${template_id}" "${name}"
            done
        fi

        # Status summary
        local image_count
        image_count=$(aws s3 ls "s3://${S3_BUCKET}/gallery/experiments/" \
            --region "${REGION}" --recursive 2>/dev/null | grep -c "/full/.*\.png$" || echo 0)
        local running_instances
        running_instances=$(aws ec2 describe-instances --region "${REGION}" \
            --filters "Name=tag:Purpose,Values=eval-batch" \
                      "Name=instance-state-name,Values=running,pending" \
            --query 'length(Reservations[].Instances[])' --output text 2>/dev/null || echo 0)
        log "[$(date '+%H:%M:%S')] Done: ${done_count}/${NUM_WORKERS} | Running: ${running_instances} | Images: ${image_count}/7150"

        sleep "${WATCH_INTERVAL}"
    done
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

    # Delete orphaned eval volumes (shouldn't exist with DeleteOnTermination, but safety net)
    local eval_vols
    eval_vols=$(aws ec2 describe-volumes --region "${REGION}" \
        --filters "Name=tag:Purpose,Values=eval-batch" "Name=status,Values=available" \
        --query 'Volumes[].VolumeId' --output text 2>/dev/null || true)
    if [[ -n "$eval_vols" && "$eval_vols" != "None" ]]; then
        for vol in ${eval_vols}; do
            log "  Deleting orphaned volume: ${vol}"
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

    # Delete launch templates
    local templates
    templates=$(aws ec2 describe-launch-templates --region "${REGION}" \
        --filters "Name=launch-template-name,Values=r18-eval-*" \
        --query 'LaunchTemplates[].LaunchTemplateId' --output text 2>/dev/null || true)
    if [[ -n "$templates" && "$templates" != "None" ]]; then
        for lt in ${templates}; do
            log "  Deleting launch template: ${lt}"
            aws ec2 delete-launch-template --region "${REGION}" --launch-template-id "${lt}" 2>/dev/null || true
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
    local ami_override=""

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --skip-snapshot) skip_snapshot="$2"; shift 2 ;;
            --ami) ami_override="$2"; shift 2 ;;
            --prefer-g5) SPOT_INSTANCE_TYPES=("g5.xlarge"); OD_INSTANCE_TYPE="g5.xlarge"; shift ;;
            --spot-only) OD_INSTANCE_TYPE=""; shift ;;
            --no-watch) NO_WATCH=true; shift ;;
            --status) check_progress; exit 0 ;;
            --cleanup) cleanup; exit 0 ;;
            -h|--help)
                cat << HELPEOF
Usage: $0 [OPTIONS]

Options:
  --skip-snapshot SNAP_ID  Reuse existing snapshot (skip creation)
  --ami AMI_ID             Use specific AMI (default: auto-detect from tags)
  --prefer-g5              Use g5.xlarge only (skip g6e)
  --no-watch               Launch only, don't enter watch mode
  --status                 Check worker progress
  --cleanup                Terminate workers + delete resources

EC2 Fleet strategy:
  Spot types: ${SPOT_INSTANCE_TYPES[*]}
  OD fallback: ${OD_INSTANCE_TYPE:-disabled}
  AZs: us-east-1a/b/c/d/f (all 5)

Auto-retry:
  Interrupted Spot workers are auto-relaunched (max ${MAX_RETRIES}/worker)
  Beyond ${MAX_RETRIES} retries → forced On-Demand
  generate-eval.py auto-resumes from S3 (no duplicate work)
HELPEOF
                exit 0 ;;
            *) err "Unknown: $1"; exit 1 ;;
        esac
    done

    # Step 0: Determine AMI
    local ami_id
    if [[ -n "${ami_override}" ]]; then
        ami_id="${ami_override}"
        log "Using specified AMI: ${ami_id}"
    else
        ami_id=$(aws ec2 describe-images --region "${REGION}" --owners self \
            --filters "Name=tag:Name,Values=r18-anime-gpu-with-driver" \
                      "Name=state,Values=available" \
            --query 'sort_by(Images, &CreationDate)[-1].ImageId' --output text 2>/dev/null)
        if [[ -z "$ami_id" || "$ami_id" == "None" ]]; then
            err "No custom AMI found (tag: r18-anime-gpu-with-driver)"
            err "Create one: aws ec2 create-image --instance-id SOURCE --name NAME --no-reboot --tag-specifications 'ResourceType=image,Tags=[{Key=Name,Value=r18-anime-gpu-with-driver}]'"
            exit 1
        fi
        log "Using latest custom AMI: ${ami_id}"
    fi

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

    # Step 3: Create launch template
    local template_result template_id template_name
    template_result=$(create_launch_template "${ami_id}" "${snap_id}")
    template_id="${template_result%%:*}"
    template_name="${template_result##*:}"

    # Step 4: Launch workers via EC2 Fleet
    log "Launching ${NUM_WORKERS} workers via EC2 Fleet (capacity-optimized)..."
    log "  Instance types: ${SPOT_INSTANCE_TYPES[*]}"
    log "  AZs: all 5 (us-east-1a/b/c/d/f)"

    local instance_ids=()
    local failed=0
    for i in $(seq 0 $((NUM_WORKERS - 1))); do
        local iid
        iid=$(launch_worker_fleet "${template_id}" "$i") || {
            err "Failed to launch ${WORKER_NAMES[$i]}"
            failed=$((failed + 1))
            continue
        }
        instance_ids+=("$iid")
    done

    # Save state
    cat > "${STATE_FILE}" << STATEOF
{
    "snapshot_id": "${snap_id}",
    "ami_id": "${ami_id}",
    "launch_template": "${template_id}",
    "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "instance_types": "$(IFS=,; echo "${SPOT_INSTANCE_TYPES[*]}")",
    "workers": ${NUM_WORKERS},
    "failed": ${failed}
}
STATEOF

    log ""
    log "============================================================"
    log "  Parallel eval started (EC2 Fleet)"
    log "============================================================"
    log "  Snapshot:  ${snap_id}"
    log "  AMI:       ${ami_id}"
    log "  Template:  ${template_id}"
    log "  Workers:   $((NUM_WORKERS - failed))/${NUM_WORKERS} launched"
    if [[ $failed -gt 0 ]]; then
        log "  Failed:    ${failed} (check Spot capacity)"
    fi
    log "  Spot:      ${SPOT_INSTANCE_TYPES[*]}"
    log "  OD fallback: ${OD_INSTANCE_TYPE:-disabled}"
    log "  Strategy:  Spot first (capacity-optimized) → OD fallback"
    log "------------------------------------------------------------"
    log "  Workers self-terminate on completion"
    log "  Volumes auto-delete on termination (no orphans)"
    if [[ "${NO_WATCH:-}" == "true" ]]; then
        log "  Monitor:   $0 --status"
        log "  Cleanup:   $0 --cleanup"
    else
        log "  Auto-retry: max ${MAX_RETRIES}/worker, then force On-Demand"
    fi
    log "============================================================"

    # Step 5: Enter watch mode (auto-retry interrupted workers)
    if [[ "${NO_WATCH:-}" != "true" ]]; then
        watch_and_retry "${template_id}"
    fi
}

main "$@"
