#!/bin/bash
set -euo pipefail

# SSH connection helper for r18-anime GPU instance
# Usage: ./connect.sh [--tunnel-only] [--ip]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source .env from same directory or parent directory
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    source "$SCRIPT_DIR/.env"
elif [[ -f "$SCRIPT_DIR/../.env" ]]; then
    source "$SCRIPT_DIR/../.env"
fi

SSH_KEY_PATH="${SSH_KEY_PATH:?SSH_KEY_PATH not set in .env}"
LOCAL_COMFYUI_PORT="${LOCAL_COMFYUI_PORT:-8188}"
SSH_USER="${SSH_USER:-ubuntu}"
INSTANCE_TAG="r18-anime-gpu"

# Parse flags
TUNNEL_ONLY=false
IP_ONLY=false
for arg in "$@"; do
    case "$arg" in
        --tunnel-only) TUNNEL_ONLY=true ;;
        --ip)          IP_ONLY=true ;;
        -h|--help)
            echo "Usage: $(basename "$0") [--tunnel-only] [--ip]"
            echo ""
            echo "Connect to the r18-anime GPU instance via SSH."
            echo ""
            echo "Options:"
            echo "  --tunnel-only  Create SSH tunnel in background (no interactive shell)"
            echo "  --ip           Print the instance public IP and exit"
            echo "  -h, --help     Show this help"
            echo ""
            echo "Environment variables (via .env):"
            echo "  SSH_KEY_PATH        Path to SSH private key (required)"
            echo "  LOCAL_COMFYUI_PORT  Local port for ComfyUI tunnel (default: 8188)"
            echo "  SSH_USER            SSH user (default: ubuntu)"
            exit 0
            ;;
        *)
            echo "Error: Unknown option: $arg" >&2
            exit 1
            ;;
    esac
done

# Find running instance by tag Name=r18-anime-gpu
echo "Looking for running instance with tag Name=$INSTANCE_TAG..."
PUBLIC_IP=$(aws ec2 describe-instances \
    --filters \
        "Name=tag:Name,Values=$INSTANCE_TAG" \
        "Name=instance-state-name,Values=running" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' \
    --output text)

if [[ -z "$PUBLIC_IP" || "$PUBLIC_IP" == "None" ]]; then
    echo "Error: No running instance found with tag Name=$INSTANCE_TAG" >&2
    exit 1
fi

echo "Found instance at $PUBLIC_IP"

# --ip: just print IP and exit
if [[ "$IP_ONLY" == true ]]; then
    echo "$PUBLIC_IP"
    exit 0
fi

# --tunnel-only: create tunnel in background
if [[ "$TUNNEL_ONLY" == true ]]; then
    echo "Creating SSH tunnel in background..."
    echo "  Local port $LOCAL_COMFYUI_PORT -> remote 127.0.0.1:8188"
    ssh -f -N -L "${LOCAL_COMFYUI_PORT}:127.0.0.1:8188" \
        -i "$SSH_KEY_PATH" \
        -o StrictHostKeyChecking=accept-new \
        "${SSH_USER}@${PUBLIC_IP}"
    echo "Tunnel established."
    echo "ComfyUI URL: http://localhost:${LOCAL_COMFYUI_PORT}"
    exit 0
fi

# Default: interactive SSH with port forwarding
echo "Connecting with port forwarding..."
echo "  Local port $LOCAL_COMFYUI_PORT -> remote 127.0.0.1:8188"
echo "  ComfyUI URL: http://localhost:${LOCAL_COMFYUI_PORT}"
echo ""
ssh -L "${LOCAL_COMFYUI_PORT}:127.0.0.1:8188" \
    -i "$SSH_KEY_PATH" \
    -o StrictHostKeyChecking=accept-new \
    "${SSH_USER}@${PUBLIC_IP}"
