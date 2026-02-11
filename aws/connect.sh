#!/bin/bash
set -euo pipefail

# SSM connection helper for r18-anime GPU instance
# Usage: ./connect.sh [--port-forward PORT] [--url]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source .env from same directory or parent directory
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    source "$SCRIPT_DIR/.env"
elif [[ -f "$SCRIPT_DIR/../.env" ]]; then
    source "$SCRIPT_DIR/../.env"
fi

INSTANCE_TAG="r18-anime-gpu"

# Parse flags
PORT_FORWARD=""
URL_ONLY=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --port-forward)
            shift
            PORT_FORWARD="${1:?--port-forward requires a PORT value}"
            shift
            ;;
        --url)
            URL_ONLY=true
            shift
            ;;
        -h|--help)
            echo "Usage: $(basename "$0") [--port-forward PORT] [--url]"
            echo ""
            echo "Connect to the r18-anime GPU instance via SSM Session Manager."
            echo ""
            echo "Options:"
            echo "  --port-forward PORT  Forward a remote port to localhost via SSM"
            echo "  --url                Print the CloudFront URL and exit"
            echo "  -h, --help           Show this help"
            echo ""
            echo "Environment variables (via .env):"
            echo "  CLOUDFRONT_URL  CloudFront distribution URL"
            exit 0
            ;;
        *)
            echo "Error: Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

# --url: print CloudFront URL and exit
if [[ "$URL_ONLY" == true ]]; then
    echo "${CLOUDFRONT_URL:?CLOUDFRONT_URL not set in .env}"
    exit 0
fi

# Find running instance by tag Name=r18-anime-gpu
echo "Looking for running instance with tag Name=$INSTANCE_TAG..."
INSTANCE_ID=$(aws ec2 describe-instances \
    --filters \
        "Name=tag:Name,Values=$INSTANCE_TAG" \
        "Name=instance-state-name,Values=running" \
    --query 'Reservations[0].Instances[0].InstanceId' \
    --output text)

if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == "None" ]]; then
    echo "Error: No running instance found with tag Name=$INSTANCE_TAG" >&2
    exit 1
fi

echo "Found instance: $INSTANCE_ID"

# --port-forward: SSM port forwarding
if [[ -n "$PORT_FORWARD" ]]; then
    echo "Starting SSM port forwarding: localhost:${PORT_FORWARD} -> remote:${PORT_FORWARD}"
    aws ssm start-session \
        --target "$INSTANCE_ID" \
        --document-name AWS-StartPortForwardingSession \
        --parameters "portNumber=${PORT_FORWARD},localPortNumber=${PORT_FORWARD}"
    exit 0
fi

# Default: interactive SSM session
echo "Starting SSM session..."
aws ssm start-session --target "$INSTANCE_ID"
