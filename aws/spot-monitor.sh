#!/bin/bash
set -euo pipefail

# ============================================================================
# spot-monitor.sh - Spot Instance Interruption Detector
#
# Runs as a background daemon on EC2. Polls the instance metadata endpoint
# for spot termination notices and triggers data sync when detected.
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
METADATA_URL="http://169.254.169.254/latest/meta-data/spot/instance-action"
METADATA_TOKEN_URL="http://169.254.169.254/latest/api/token"
CHECK_INTERVAL=5
LOG_FILE="/var/log/spot-monitor.log"
PID_FILE="/var/run/spot-monitor.pid"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
    echo "${msg}" | tee -a "${LOG_FILE}" 2>/dev/null || echo "${msg}"
}

err() { log "ERROR: $*"; }

# ---------------------------------------------------------------------------
# Load .env
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
Usage: $(basename "$0") [COMMAND] [OPTIONS]

Monitor EC2 spot instance for interruption notices and trigger data sync.
Must be run ON the EC2 instance.

Commands:
    start           Start the monitor daemon (default)
    stop            Stop a running monitor daemon
    status          Check if the monitor is running

Options:
    --foreground    Run in foreground (do not daemonize)
    -h, --help      Show this help

This script should be run as root or with sudo for PID file and log access.
EOF
    exit 0
}

# ---------------------------------------------------------------------------
# IMDSv2 token management
# ---------------------------------------------------------------------------
get_imds_token() {
    curl -s -f -X PUT "${METADATA_TOKEN_URL}" \
        -H "X-aws-ec2-metadata-token-ttl-seconds:300" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Check spot interruption notice
# ---------------------------------------------------------------------------
check_interruption() {
    local token="$1"
    local response
    local http_code

    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "X-aws-ec2-metadata-token: ${token}" \
        "${METADATA_URL}" 2>/dev/null || echo "000")

    if [[ "${http_code}" == "200" ]]; then
        response=$(curl -s -f \
            -H "X-aws-ec2-metadata-token: ${token}" \
            "${METADATA_URL}" 2>/dev/null || true)
        echo "${response}"
        return 0
    fi

    # 404 = no interruption notice (normal)
    # Other codes = metadata service issue
    if [[ "${http_code}" != "404" ]]; then
        err "Metadata endpoint returned HTTP ${http_code}"
    fi
    return 1
}

# ---------------------------------------------------------------------------
# Handle interruption: run sync scripts
# ---------------------------------------------------------------------------
handle_interruption() {
    local action_data="$1"
    log "========================================="
    log "SPOT INTERRUPTION DETECTED"
    log "Action data: ${action_data}"
    log "========================================="
    log "Starting emergency data sync..."

    local sync_output="${SCRIPT_DIR}/sync-output.sh"
    local sync_models="${SCRIPT_DIR}/sync-models.sh"
    local exit_code=0

    # Run sync-output.sh
    if [[ -x "${sync_output}" ]]; then
        log "Running sync-output.sh..."
        if "${sync_output}" 2>&1 | tee -a "${LOG_FILE}"; then
            log "sync-output.sh completed successfully"
        else
            err "sync-output.sh failed with exit code $?"
            exit_code=1
        fi
    else
        err "sync-output.sh not found or not executable at ${sync_output}"
        exit_code=1
    fi

    # Run sync-models.sh
    if [[ -x "${sync_models}" ]]; then
        log "Running sync-models.sh..."
        if "${sync_models}" 2>&1 | tee -a "${LOG_FILE}"; then
            log "sync-models.sh completed successfully"
        else
            err "sync-models.sh failed with exit code $?"
            exit_code=1
        fi
    else
        err "sync-models.sh not found or not executable at ${sync_models}"
        exit_code=1
    fi

    if [[ ${exit_code} -eq 0 ]]; then
        log "All sync operations completed successfully"
    else
        err "Some sync operations failed"
    fi
    log "Emergency sync finished. Instance will be interrupted shortly."
    return ${exit_code}
}

# ---------------------------------------------------------------------------
# Daemon management
# ---------------------------------------------------------------------------
write_pid() {
    echo $$ > "${PID_FILE}" 2>/dev/null || true
}

read_pid() {
    if [[ -f "${PID_FILE}" ]]; then
        cat "${PID_FILE}" 2>/dev/null || true
    fi
}

is_running() {
    local pid
    pid=$(read_pid)
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
        return 0
    fi
    return 1
}

stop_daemon() {
    if is_running; then
        local pid
        pid=$(read_pid)
        log "Stopping spot-monitor (PID: ${pid})"
        kill "${pid}" 2>/dev/null || true
        sleep 1
        if kill -0 "${pid}" 2>/dev/null; then
            kill -9 "${pid}" 2>/dev/null || true
        fi
        rm -f "${PID_FILE}"
        log "Stopped"
    else
        log "spot-monitor is not running"
    fi
}

show_status() {
    if is_running; then
        local pid
        pid=$(read_pid)
        log "spot-monitor is running (PID: ${pid})"
    else
        log "spot-monitor is not running"
    fi
}

# ---------------------------------------------------------------------------
# Main monitor loop
# ---------------------------------------------------------------------------
monitor_loop() {
    write_pid
    trap 'log "Shutting down spot-monitor"; rm -f "${PID_FILE}"; exit 0' SIGTERM SIGINT

    log "Spot monitor started (PID: $$)"
    log "Checking every ${CHECK_INTERVAL} seconds"
    log "Metadata endpoint: ${METADATA_URL}"

    local token=""
    local token_time=0
    local interrupted=false

    while true; do
        # Refresh IMDSv2 token every 4 minutes (tokens last 5 minutes)
        local now
        now=$(date +%s)
        if (( now - token_time > 240 )) || [[ -z "${token}" ]]; then
            token=$(get_imds_token)
            if [[ -z "${token}" ]]; then
                err "Failed to get IMDSv2 token. Retrying in ${CHECK_INTERVAL}s..."
                sleep "${CHECK_INTERVAL}"
                continue
            fi
            token_time=${now}
        fi

        # Check for interruption
        local action_data
        if action_data=$(check_interruption "${token}"); then
            if [[ "${interrupted}" == false ]]; then
                interrupted=true
                handle_interruption "${action_data}"
                # Keep running to log any additional events, but sync is done
            fi
        fi

        sleep "${CHECK_INTERVAL}"
    done
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    local command="start"
    local foreground=false

    while [[ $# -gt 0 ]]; do
        case "$1" in
            start)        command="start"; shift ;;
            stop)         command="stop"; shift ;;
            status)       command="status"; shift ;;
            --foreground) foreground=true; shift ;;
            -h|--help)    usage ;;
            *)            err "Unknown option: $1"; usage ;;
        esac
    done

    load_env

    case "${command}" in
        stop)
            stop_daemon
            ;;
        status)
            show_status
            ;;
        start)
            if is_running; then
                local pid
                pid=$(read_pid)
                log "spot-monitor is already running (PID: ${pid})"
                exit 0
            fi

            # Ensure log directory exists
            mkdir -p "$(dirname "${LOG_FILE}")" 2>/dev/null || true
            touch "${LOG_FILE}" 2>/dev/null || LOG_FILE="/tmp/spot-monitor.log"

            if [[ "${foreground}" == true ]]; then
                monitor_loop
            else
                log "Starting spot-monitor daemon..."
                nohup "$0" start --foreground >> "${LOG_FILE}" 2>&1 &
                disown
                sleep 1
                if is_running; then
                    local pid
                    pid=$(read_pid)
                    log "spot-monitor daemon started (PID: ${pid})"
                    log "Log file: ${LOG_FILE}"
                else
                    err "Failed to start spot-monitor daemon"
                    exit 1
                fi
            fi
            ;;
    esac
}

main "$@"
