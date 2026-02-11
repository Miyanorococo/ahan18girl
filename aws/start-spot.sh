#!/bin/bash
set -euo pipefail

# ============================================================================
# start-spot.sh - Spot/On-Demand Instance Launcher for r18-anime-gpu
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTANCE_TAG="r18-anime-gpu"
REGION="us-east-1"
COMFYUI_PORT=8188

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
err()  { log "ERROR: $*" >&2; }
die()  { err "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Load .env
# ---------------------------------------------------------------------------
load_env() {
    local env_file=""
    if [[ -f "${SCRIPT_DIR}/.env" ]]; then
        env_file="${SCRIPT_DIR}/.env"
    elif [[ -f "${SCRIPT_DIR}/../.env" ]]; then
        env_file="${SCRIPT_DIR}/../.env"
    else
        die ".env file not found in ${SCRIPT_DIR} or parent directory"
    fi
    log "Loading config from ${env_file}"
    set -a
    # shellcheck source=/dev/null
    source "${env_file}"
    set +a
}

# ---------------------------------------------------------------------------
# Defaults & config validation
# ---------------------------------------------------------------------------
validate_config() {
    : "${LAUNCH_TEMPLATE_ID:?LAUNCH_TEMPLATE_ID is required in .env}"
    : "${SUBNET_ID:?SUBNET_ID is required in .env}"
    : "${PREFERRED_AZ:=us-east-1c}"
    : "${EBS_VOLUME_ID:?EBS_VOLUME_ID is required in .env}"
    : "${S3_BUCKET:?S3_BUCKET is required in .env}"
    : "${DEFAULT_INSTANCE_TYPE:=g6e.xlarge}"
    : "${FALLBACK_INSTANCE_TYPE:=g5.xlarge}"
    : "${TARGET_GROUP_ARN:?TARGET_GROUP_ARN is required in .env}"
}

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Launch an EC2 instance for r18-anime-gpu workloads.

Options:
    --fallback g5       Use g5.xlarge (A10G 24GB) instead of g6e.xlarge (L40S 48GB)
    --on-demand         Launch as on-demand instead of spot
    --az ZONE           Override availability zone (default: ${PREFERRED_AZ:-us-east-1c})
    -h, --help          Show this help

Examples:
    $(basename "$0")                    # Spot g6e.xlarge in us-east-1c
    $(basename "$0") --fallback g5      # Spot g5.xlarge
    $(basename "$0") --on-demand        # On-demand g6e.xlarge
EOF
    exit 0
}

# ---------------------------------------------------------------------------
# Check for existing running instances
# ---------------------------------------------------------------------------
check_existing_instance() {
    local existing
    existing=$(aws ec2 describe-instances \
        --region "${REGION}" \
        --filters \
            "Name=tag:Name,Values=${INSTANCE_TAG}" \
            "Name=instance-state-name,Values=running,pending" \
        --query 'Reservations[].Instances[].InstanceId' \
        --output text 2>/dev/null || true)

    if [[ -n "${existing}" && "${existing}" != "None" ]]; then
        local ip
        ip=$(aws ec2 describe-instances \
            --region "${REGION}" \
            --instance-ids "${existing}" \
            --query 'Reservations[].Instances[].PublicIpAddress' \
            --output text 2>/dev/null || true)
        log "Instance already running: ${existing} (${ip:-no public IP})"
        log "Use stop-instance.sh first, or connect directly."
        die "Aborting to avoid duplicate instances."
    fi
}

# ---------------------------------------------------------------------------
# Launch via spot request
# ---------------------------------------------------------------------------
launch_spot() {
    local instance_type="$1"
    local az="$2"

    log "Requesting spot instance: ${instance_type} in ${az}"

    local sir_id
    sir_id=$(aws ec2 request-spot-instances \
        --region "${REGION}" \
        --instance-count 1 \
        --type "one-time" \
        --launch-specification "{
            \"ImageId\": null,
            \"InstanceType\": \"${instance_type}\",
            \"SubnetId\": \"${SUBNET_ID}\",
            \"Placement\": {\"AvailabilityZone\": \"${az}\"}
        }" \
        --query 'SpotInstanceRequests[0].SpotInstanceRequestId' \
        --output text 2>/dev/null || true)

    # Use run-instances with spot market options instead (more reliable with launch templates)
    local instance_id
    instance_id=$(aws ec2 run-instances \
        --region "${REGION}" \
        --launch-template "LaunchTemplateId=${LAUNCH_TEMPLATE_ID}" \
        --instance-type "${instance_type}" \
        --subnet-id "${SUBNET_ID}" \
        --placement "AvailabilityZone=${az}" \
        --instance-market-options '{"MarketType":"spot","SpotOptions":{"SpotInstanceType":"one-time"}}' \
        --query 'Instances[0].InstanceId' \
        --output text)

    [[ -n "${instance_id}" && "${instance_id}" != "None" ]] \
        || die "Failed to launch spot instance"

    echo "${instance_id}"
}

# ---------------------------------------------------------------------------
# Launch via on-demand
# ---------------------------------------------------------------------------
launch_on_demand() {
    local instance_type="$1"
    local az="$2"

    log "Launching on-demand instance: ${instance_type} in ${az}"

    local instance_id
    instance_id=$(aws ec2 run-instances \
        --region "${REGION}" \
        --launch-template "LaunchTemplateId=${LAUNCH_TEMPLATE_ID}" \
        --instance-type "${instance_type}" \
        --subnet-id "${SUBNET_ID}" \
        --placement "AvailabilityZone=${az}" \
        --query 'Instances[0].InstanceId' \
        --output text)

    [[ -n "${instance_id}" && "${instance_id}" != "None" ]] \
        || die "Failed to launch on-demand instance"

    echo "${instance_id}"
}

# ---------------------------------------------------------------------------
# Wait for instance to be running and get public IP
# ---------------------------------------------------------------------------
wait_for_instance() {
    local instance_id="$1"

    log "Waiting for instance ${instance_id} to reach 'running' state..."
    aws ec2 wait instance-running \
        --region "${REGION}" \
        --instance-ids "${instance_id}"

    local public_ip
    public_ip=$(aws ec2 describe-instances \
        --region "${REGION}" \
        --instance-ids "${instance_id}" \
        --query 'Reservations[0].Instances[0].PublicIpAddress' \
        --output text)

    [[ -n "${public_ip}" && "${public_ip}" != "None" ]] \
        || die "Instance ${instance_id} has no public IP"

    echo "${public_ip}"
}

# ---------------------------------------------------------------------------
# Register instance with ALB target group
# ---------------------------------------------------------------------------
register_with_alb() {
    local instance_id="$1"

    log "Registering instance ${instance_id} with ALB target group..."
    aws elbv2 register-targets \
        --target-group-arn "${TARGET_GROUP_ARN}" \
        --targets "Id=${instance_id}"
    log "Instance registered with ALB target group"
}

# ---------------------------------------------------------------------------
# Wait for ALB target to become healthy
# ---------------------------------------------------------------------------
wait_for_healthy() {
    local instance_id="$1"
    local max_attempts=30
    local attempt=0

    log "Waiting for target to become healthy..."
    while (( attempt < max_attempts )); do
        local health
        health=$(aws elbv2 describe-target-health \
            --target-group-arn "${TARGET_GROUP_ARN}" \
            --targets "Id=${instance_id}" \
            --query 'TargetHealthDescriptions[0].TargetHealth.State' \
            --output text 2>/dev/null || true)

        if [[ "${health}" == "healthy" ]]; then
            log "Target is healthy"
            return 0
        fi
        log "  Target health: ${health:-unknown} (attempt $((attempt + 1))/${max_attempts})"
        (( attempt++ ))
        sleep 10
    done
    die "Target not healthy after $((max_attempts * 10)) seconds"
}

# ---------------------------------------------------------------------------
# Print connection info
# ---------------------------------------------------------------------------
print_connection_info() {
    local instance_id="$1"
    local instance_type="$2"
    local mode="$3"

    cat <<EOF

============================================================
  Instance launched successfully
============================================================
  Instance ID:    ${instance_id}
  Instance Type:  ${instance_type}
  Mode:           ${mode}
  AZ:             ${az}
------------------------------------------------------------
  ComfyUI:        ${CLOUDFRONT_URL:-N/A}
  SSM Session:    aws ssm start-session --target ${instance_id}
------------------------------------------------------------
  Stop:           ./stop-instance.sh
  Terminate:      ./stop-instance.sh --terminate
============================================================
EOF
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    local instance_type=""
    local mode="spot"
    local az=""

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --fallback)
                shift
                case "${1:-}" in
                    g5) instance_type="${FALLBACK_INSTANCE_TYPE}" ;;
                    *)  die "Unknown fallback type: ${1:-}. Supported: g5" ;;
                esac
                shift
                ;;
            --on-demand)
                mode="on-demand"
                shift
                ;;
            --az)
                shift
                az="${1:?--az requires a value}"
                shift
                ;;
            -h|--help)
                usage
                ;;
            *)
                die "Unknown option: $1. Use --help for usage."
                ;;
        esac
    done

    load_env
    validate_config

    # Apply defaults after config is loaded
    instance_type="${instance_type:-${DEFAULT_INSTANCE_TYPE}}"
    az="${az:-${PREFERRED_AZ}}"

    log "Configuration:"
    log "  Instance type: ${instance_type}"
    log "  Mode:          ${mode}"
    log "  AZ:            ${az}"
    log "  Launch Template: ${LAUNCH_TEMPLATE_ID}"

    check_existing_instance

    # Launch instance
    local instance_id
    if [[ "${mode}" == "spot" ]]; then
        instance_id=$(launch_spot "${instance_type}" "${az}")
    else
        instance_id=$(launch_on_demand "${instance_type}" "${az}")
    fi

    log "Instance ID: ${instance_id}"

    # Wait for running state
    local public_ip
    public_ip=$(wait_for_instance "${instance_id}")
    log "Public IP: ${public_ip}"

    # Register with ALB and wait for healthy
    register_with_alb "${instance_id}"
    wait_for_healthy "${instance_id}"

    print_connection_info "${instance_id}" "${instance_type}" "${mode}"
}

main "$@"
