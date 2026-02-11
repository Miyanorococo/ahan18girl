#!/bin/bash
set -euo pipefail

# CloudFormation deployment helper for r18-anime infrastructure
# Usage: ./deploy-stack.sh [--delete]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source .env from same directory or parent directory
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    source "$SCRIPT_DIR/.env"
elif [[ -f "$SCRIPT_DIR/../.env" ]]; then
    source "$SCRIPT_DIR/../.env"
fi

CF_STACK_NAME="${CF_STACK_NAME:-r18-anime-stack}"
S3_BUCKET="${S3_BUCKET:-r18-anime-assets}"
MY_IP="${MY_IP:?MY_IP not set in .env (e.g. 203.0.113.1/32)}"
PREFERRED_AZ="${PREFERRED_AZ:-us-east-1c}"
TEMPLATE_FILE="$SCRIPT_DIR/cloudformation.yml"

# Parse flags
DELETE_STACK=false
for arg in "$@"; do
    case "$arg" in
        --delete)
            DELETE_STACK=true
            ;;
        -h|--help)
            echo "Usage: $(basename "$0") [--delete]"
            echo ""
            echo "Deploy or update the r18-anime CloudFormation stack."
            echo ""
            echo "Options:"
            echo "  --delete   Delete the stack instead of deploying"
            echo "  -h, --help Show this help"
            echo ""
            echo "Environment variables (via .env):"
            echo "  CF_STACK_NAME  Stack name (default: r18-anime-stack)"
            echo "  S3_BUCKET      S3 bucket name (default: r18-anime-assets)"
            echo "  MY_IP          Your IP with /32 suffix (required)"
            echo "  PREFERRED_AZ   Availability zone (default: us-east-1c)"
            exit 0
            ;;
        *)
            echo "Error: Unknown option: $arg" >&2
            exit 1
            ;;
    esac
done

# --delete: delete the stack
if [[ "$DELETE_STACK" == true ]]; then
    echo "Deleting stack: $CF_STACK_NAME"
    aws cloudformation delete-stack --stack-name "$CF_STACK_NAME"
    echo "Waiting for stack deletion to complete..."
    aws cloudformation wait stack-delete-complete --stack-name "$CF_STACK_NAME"
    echo "Stack deleted."
    exit 0
fi

# Validate template
echo "Validating CloudFormation template..."
aws cloudformation validate-template --template-body "file://$TEMPLATE_FILE" > /dev/null
echo "Template is valid."

# Deploy/update stack
echo "Deploying stack: $CF_STACK_NAME"
aws cloudformation deploy \
    --stack-name "$CF_STACK_NAME" \
    --template-file "$TEMPLATE_FILE" \
    --parameter-overrides \
        "MyIP=$MY_IP" \
        "S3BucketName=$S3_BUCKET" \
        "AvailabilityZone=$PREFERRED_AZ" \
    --capabilities CAPABILITY_NAMED_IAM \
    --no-fail-on-empty-changeset

echo "Stack deployment complete."

# Fetch and display outputs
echo ""
echo "Stack outputs:"
OUTPUTS=$(aws cloudformation describe-stacks \
    --stack-name "$CF_STACK_NAME" \
    --query 'Stacks[0].Outputs' \
    --output json)

echo "$OUTPUTS" | python3 -c "
import json, sys
outputs = json.load(sys.stdin)
if not outputs:
    print('  (no outputs)')
    sys.exit()
for o in outputs:
    print(f\"  {o['OutputKey']}: {o['OutputValue']}\")
"

# Save outputs to .env
ENV_FILE="$SCRIPT_DIR/.env"
echo ""
echo "Saving stack outputs to $ENV_FILE..."

# Extract each output value
VPC_ID=$(echo "$OUTPUTS" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='VPCId'))")
SUBNET_ID=$(echo "$OUTPUTS" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='SubnetId'))")
SG_ID=$(echo "$OUTPUTS" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='SecurityGroupId'))")
LAUNCH_TEMPLATE_ID=$(echo "$OUTPUTS" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='LaunchTemplateId'))")
EBS_VOLUME_ID=$(echo "$OUTPUTS" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='EBSVolumeId'))")
S3_BUCKET_NAME=$(echo "$OUTPUTS" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='S3BucketName'))")
CLOUDFRONT_DOMAIN=$(echo "$OUTPUTS" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='CloudFrontDomainName'))")
CLOUDFRONT_URL="https://${CLOUDFRONT_DOMAIN}"
TARGET_GROUP_ARN=$(echo "$OUTPUTS" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='TargetGroupArn'))")
PRIVATE_SUBNET_ID=$(echo "$OUTPUTS" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='PrivateSubnetId'))")

# Update or append each variable in .env
update_env_var() {
    local key="$1" value="$2" file="$3"
    if [[ -f "$file" ]] && grep -q "^${key}=" "$file"; then
        sed -i '' "s|^${key}=.*|${key}=${value}|" "$file"
    else
        echo "${key}=${value}" >> "$file"
    fi
}

touch "$ENV_FILE"
update_env_var "VPC_ID" "$VPC_ID" "$ENV_FILE"
update_env_var "SUBNET_ID" "$SUBNET_ID" "$ENV_FILE"
update_env_var "SG_ID" "$SG_ID" "$ENV_FILE"
update_env_var "LAUNCH_TEMPLATE_ID" "$LAUNCH_TEMPLATE_ID" "$ENV_FILE"
update_env_var "EBS_VOLUME_ID" "$EBS_VOLUME_ID" "$ENV_FILE"
update_env_var "S3_BUCKET_NAME" "$S3_BUCKET_NAME" "$ENV_FILE"
update_env_var "CLOUDFRONT_URL" "$CLOUDFRONT_URL" "$ENV_FILE"
update_env_var "TARGET_GROUP_ARN" "$TARGET_GROUP_ARN" "$ENV_FILE"
update_env_var "PRIVATE_SUBNET_ID" "$PRIVATE_SUBNET_ID" "$ENV_FILE"

echo "Saved: VPC_ID, SUBNET_ID, SG_ID, LAUNCH_TEMPLATE_ID, EBS_VOLUME_ID, S3_BUCKET_NAME, CLOUDFRONT_URL, TARGET_GROUP_ARN, PRIVATE_SUBNET_ID"
echo ""
echo "CloudFront URL: $CLOUDFRONT_URL"
echo "Done."
