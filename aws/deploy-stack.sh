#!/bin/bash
set -euo pipefail

# CloudFormation deployment helper for r18-anime infrastructure
# Deploys in 2 stages: base infra (VPC/ALB/SSM) then CloudFront
# Usage: ./deploy-stack.sh [--delete] [--cloudfront-only]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source .env from same directory or parent directory
if [[ -f "$SCRIPT_DIR/../.env" ]]; then
    source "$SCRIPT_DIR/../.env"
elif [[ -f "$SCRIPT_DIR/.env" ]]; then
    source "$SCRIPT_DIR/.env"
fi

CF_STACK_NAME="${CF_STACK_NAME:-r18-anime-stack}"
CF_CF_STACK_NAME="${CF_STACK_NAME}-cloudfront"
S3_BUCKET="${S3_BUCKET:-r18-anime-assets}"
BASIC_AUTH_USER="${BASIC_AUTH_USER:-admin}"
BASIC_AUTH_PASS="${BASIC_AUTH_PASS:?BASIC_AUTH_PASS not set in .env}"
PREFERRED_AZ="${PREFERRED_AZ:-us-east-1c}"
BASE_TEMPLATE="$SCRIPT_DIR/cloudformation.yml"
CF_TEMPLATE="$SCRIPT_DIR/cloudfront.yml"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# Update or append variable in .env
update_env_var() {
    local key="$1" value="$2" file="$3"
    if [[ -f "$file" ]] && grep -q "^${key}=" "$file"; then
        sed -i '' "s|^${key}=.*|${key}=${value}|" "$file"
    else
        echo "${key}=${value}" >> "$file"
    fi
}

get_output() {
    local outputs="$1" key="$2"
    echo "$outputs" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='$key'))"
}

# Parse flags
DELETE_STACK=false
CF_ONLY=false
for arg in "$@"; do
    case "$arg" in
        --delete)          DELETE_STACK=true ;;
        --cloudfront-only) CF_ONLY=true ;;
        -h|--help)
            echo "Usage: $(basename "$0") [--delete] [--cloudfront-only]"
            echo ""
            echo "Deploy r18-anime infrastructure (2-stage: base + CloudFront)."
            echo ""
            echo "Options:"
            echo "  --delete           Delete both stacks"
            echo "  --cloudfront-only  Deploy only the CloudFront stack"
            echo "  -h, --help         Show this help"
            exit 0
            ;;
        *) echo "Error: Unknown option: $arg" >&2; exit 1 ;;
    esac
done

# Find .env file location
ENV_FILE="$SCRIPT_DIR/../.env"
[[ -f "$ENV_FILE" ]] || ENV_FILE="$SCRIPT_DIR/.env"
touch "$ENV_FILE"

# --delete: delete both stacks
if [[ "$DELETE_STACK" == true ]]; then
    log "Deleting CloudFront stack: $CF_CF_STACK_NAME"
    aws cloudformation delete-stack --stack-name "$CF_CF_STACK_NAME" 2>/dev/null || true
    aws cloudformation wait stack-delete-complete --stack-name "$CF_CF_STACK_NAME" 2>/dev/null || true
    log "Deleting base stack: $CF_STACK_NAME"
    aws cloudformation delete-stack --stack-name "$CF_STACK_NAME"
    aws cloudformation wait stack-delete-complete --stack-name "$CF_STACK_NAME"
    log "Both stacks deleted."
    exit 0
fi

# ============================================================
# Stage 1: Base Infrastructure (VPC, ALB, SSM, EBS, S3)
# ============================================================
if [[ "$CF_ONLY" == false ]]; then
    log "=== Stage 1: Base Infrastructure ==="

    log "Validating base template..."
    aws cloudformation validate-template --template-body "file://$BASE_TEMPLATE" > /dev/null
    log "Template valid."

    log "Deploying: $CF_STACK_NAME"
    aws cloudformation deploy \
        --stack-name "$CF_STACK_NAME" \
        --template-file "$BASE_TEMPLATE" \
        --parameter-overrides \
            "S3BucketName=$S3_BUCKET" \
            "AvailabilityZone=$PREFERRED_AZ" \
        --capabilities CAPABILITY_NAMED_IAM \
        --no-fail-on-empty-changeset

    log "Base stack deployed."

    # Fetch and save base outputs
    OUTPUTS=$(aws cloudformation describe-stacks \
        --stack-name "$CF_STACK_NAME" \
        --query 'Stacks[0].Outputs' \
        --output json)

    echo ""
    echo "Base stack outputs:"
    echo "$OUTPUTS" | python3 -c "
import json, sys
for o in json.load(sys.stdin) or []:
    print(f'  {o[\"OutputKey\"]}: {o[\"OutputValue\"]}')
"

    update_env_var "VPC_ID" "$(get_output "$OUTPUTS" VPCId)" "$ENV_FILE"
    update_env_var "SUBNET_ID" "$(get_output "$OUTPUTS" PublicSubnetId)" "$ENV_FILE"
    update_env_var "PRIVATE_SUBNET_ID" "$(get_output "$OUTPUTS" PrivateSubnetId)" "$ENV_FILE"
    update_env_var "SG_ID" "$(get_output "$OUTPUTS" SecurityGroupId)" "$ENV_FILE"
    update_env_var "LAUNCH_TEMPLATE_ID" "$(get_output "$OUTPUTS" LaunchTemplateId)" "$ENV_FILE"
    update_env_var "EBS_VOLUME_ID" "$(get_output "$OUTPUTS" EBSVolumeId)" "$ENV_FILE"
    update_env_var "S3_BUCKET_NAME" "$(get_output "$OUTPUTS" S3BucketName)" "$ENV_FILE"
    update_env_var "TARGET_GROUP_ARN" "$(get_output "$OUTPUTS" TargetGroupArn)" "$ENV_FILE"

    ALB_DNS=$(get_output "$OUTPUTS" ALBDnsName)
    update_env_var "ALB_DNS_NAME" "$ALB_DNS" "$ENV_FILE"
    log "Base outputs saved to $ENV_FILE"
else
    # Read ALB DNS from .env
    ALB_DNS="${ALB_DNS_NAME:?ALB_DNS_NAME not set. Run without --cloudfront-only first.}"
fi

# ============================================================
# Stage 2: CloudFront Distribution (can take 5-15 min)
# ============================================================
log ""
log "=== Stage 2: CloudFront Distribution ==="
log "Note: CloudFront initial creation takes 5-15 minutes."

log "Validating CloudFront template..."
aws cloudformation validate-template --template-body "file://$CF_TEMPLATE" > /dev/null
log "Template valid."

log "Deploying: $CF_CF_STACK_NAME"
aws cloudformation deploy \
    --stack-name "$CF_CF_STACK_NAME" \
    --template-file "$CF_TEMPLATE" \
    --parameter-overrides \
        "BasicAuthUser=$BASIC_AUTH_USER" \
        "BasicAuthPass=$BASIC_AUTH_PASS" \
        "ALBDnsName=$ALB_DNS" \
    --no-fail-on-empty-changeset

log "CloudFront stack deployed."

# Fetch CloudFront outputs
CF_OUTPUTS=$(aws cloudformation describe-stacks \
    --stack-name "$CF_CF_STACK_NAME" \
    --query 'Stacks[0].Outputs' \
    --output json)

CLOUDFRONT_DOMAIN=$(get_output "$CF_OUTPUTS" CloudFrontDomainName)
CLOUDFRONT_URL="https://${CLOUDFRONT_DOMAIN}"

update_env_var "CLOUDFRONT_URL" "$CLOUDFRONT_URL" "$ENV_FILE"

echo ""
echo "============================================================"
log "Deployment complete!"
echo "============================================================"
echo "  CloudFront URL: $CLOUDFRONT_URL"
echo "  Auth: $BASIC_AUTH_USER / ****"
echo "============================================================"
