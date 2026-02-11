#!/bin/bash
set -euo pipefail

# ============================================================================
# stop-instance.sh - Stop or Terminate r18-anime-gpu Instance
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTANCE_TAG="r18-anime-gpu"
REGION="us-east-1"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
err()  { log "ERROR: $*" >&2; }
die()  { err "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Load .env (for SSH_KEY_PATH if needed)
# ---------------------------------------------------------------------------
load_env() {
    local env_file=""
    if [[ -f "${SCRIPT_DIR}/.env" ]]; then
        env_file="${SCRIPT_DIR}/.env"
    elif [[ -f "${SCRIPT_DIR}/../.env" ]]; then
        env_file="${SCRIPT_DIR}/../.env"
    fi
    if [[ -n "${env_file}" ]]; then
        set -a
        # shellcheck source=/dev/null
        source "${env_file}"
        set +a
    fi
}

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Stop or terminate the r18-anime-gpu EC2 instance.

Options:
    --terminate     Terminate the instance (permanent, destroys root volume)
    -y, --yes       Skip confirmation prompt
    -h, --help      Show this help

Default behavior is to STOP the instance (preservable, EBS volumes retained).

EOF
    exit 0
}

# ---------------------------------------------------------------------------
# Find running instance
# ---------------------------------------------------------------------------
find_instance() {
    local states="$1"
    aws ec2 describe-instances \
        --region "${REGION}" \
        --filters \
            "Name=tag:Name,Values=${INSTANCE_TAG}" \
            "Name=instance-state-name,Values=${states}" \
        --query 'Reservations[].Instances[].[InstanceId,InstanceType,PublicIpAddress,State.Name,Placement.AvailabilityZone,LaunchTime]' \
        --output text 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    local terminate=false
    local skip_confirm=false

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --terminate) terminate=true; shift ;;
            -y|--yes)    skip_confirm=true; shift ;;
            -h|--help)   usage ;;
            *)           die "Unknown option: $1. Use --help for usage." ;;
        esac
    done

    load_env

    # Find running or stopping instances
    local instance_info
    instance_info=$(find_instance "running,pending,stopping")

    if [[ -z "${instance_info}" || "${instance_info}" == "None" ]]; then
        log "No running ${INSTANCE_TAG} instance found."

        # Check for stopped instances
        local stopped
        stopped=$(find_instance "stopped")
        if [[ -n "${stopped}" && "${stopped}" != "None" ]]; then
            local stopped_id
            stopped_id=$(echo "${stopped}" | awk '{print $1}' | head -1)
            log "Found stopped instance: ${stopped_id}"
            if [[ "${terminate}" == true ]]; then
                log "Proceeding to terminate stopped instance."
                instance_info="${stopped}"
            else
                log "Instance is already stopped. Use --terminate to destroy it."
                exit 0
            fi
        else
            exit 0
        fi
    fi

    # Parse instance details
    local instance_id instance_type public_ip state az launch_time
    read -r instance_id instance_type public_ip state az launch_time <<< \
        "$(echo "${instance_info}" | head -1)"

    log "Found instance:"
    log "  Instance ID:    ${instance_id}"
    log "  Instance Type:  ${instance_type}"
    log "  Public IP:      ${public_ip:-N/A}"
    log "  State:          ${state}"
    log "  AZ:             ${az}"
    log "  Launched:       ${launch_time}"

    # Confirmation
    local action
    if [[ "${terminate}" == true ]]; then
        action="TERMINATE"
    else
        action="STOP"
    fi

    if [[ "${skip_confirm}" == false ]]; then
        echo ""
        read -r -p "${action} instance ${instance_id}? [y/N] " confirm
        case "${confirm}" in
            [yY][eE][sS]|[yY]) ;;
            *) log "Aborted."; exit 0 ;;
        esac
    fi

    # Deregister from ALB target group
    if [[ -n "${TARGET_GROUP_ARN:-}" ]]; then
        log "Deregistering from ALB target group..."
        aws elbv2 deregister-targets --target-group-arn "${TARGET_GROUP_ARN}" --targets "Id=${instance_id}" 2>/dev/null || true
    fi

    # Perform action
    if [[ "${terminate}" == true ]]; then
        log "Terminating instance ${instance_id}..."
        aws ec2 terminate-instances \
            --region "${REGION}" \
            --instance-ids "${instance_id}" \
            --output text >/dev/null

        log "Waiting for termination..."
        aws ec2 wait instance-terminated \
            --region "${REGION}" \
            --instance-ids "${instance_id}" 2>/dev/null || true

        log "Instance ${instance_id} terminated."
        echo ""
        log "NOTE: Root EBS volume has been destroyed."
        log "NOTE: Persistent data volume (EBS_VOLUME_ID) is NOT affected."
    else
        log "Stopping instance ${instance_id}..."
        aws ec2 stop-instances \
            --region "${REGION}" \
            --instance-ids "${instance_id}" \
            --output text >/dev/null

        log "Waiting for instance to stop..."
        aws ec2 wait instance-stopped \
            --region "${REGION}" \
            --instance-ids "${instance_id}"

        log "Instance ${instance_id} stopped."
        echo ""
        log "REMINDER: EBS volumes continue to incur charges while instance is stopped."
        log "  - Root volume (100GB gp3):       ~\$8/month"
        log "  - Data volume (200GB gp3):       ~\$16/month"
        log "  Use --terminate to destroy the instance and its root volume."
    fi
}

main "$@"
