#!/bin/bash
set -euo pipefail

# Deploy the gallery stack (Lambda + Frontend + CloudFront update)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${SCRIPT_DIR}/.."

# Load environment
source "${PROJECT_DIR}/.env"

S3_BUCKET="${S3_BUCKET:-r18-anime-assets}"
GALLERY_STACK="${GALLERY_STACK_NAME:-r18-anime-gallery-stack}"
CF_STACK="${CLOUDFRONT_STACK_NAME:-r18-anime-stack-cloudfront}"
REGION="us-east-1"

echo "============================================"
echo "  Gallery Deploy"
echo "============================================"

# Step 1: Package Lambda
echo ""
echo "[1/6] Packaging Lambda..."
LAMBDA_DIR="${PROJECT_DIR}/lambda/gallery"
LAMBDA_ZIP="/tmp/gallery-lambda.zip"

if [[ ! -d "${LAMBDA_DIR}" ]]; then
    echo "ERROR: Lambda directory not found: ${LAMBDA_DIR}"
    exit 1
fi

# Create zip (exclude __pycache__, .pyc)
(cd "${LAMBDA_DIR}" && zip -r "${LAMBDA_ZIP}" . -x '*__pycache__*' '*.pyc' 'requirements.txt')
echo "  Lambda package: $(du -h "${LAMBDA_ZIP}" | cut -f1)"

# Step 2: Upload Lambda zip to S3
echo ""
echo "[2/6] Uploading Lambda package to S3..."
aws s3 cp "${LAMBDA_ZIP}" "s3://${S3_BUCKET}/lambda/gallery.zip" --region "${REGION}"

# Step 3: Deploy gallery stack (Lambda)
echo ""
echo "[3/6] Deploying gallery stack..."
aws cloudformation deploy \
    --template-file "${SCRIPT_DIR}/gallery-stack.yml" \
    --stack-name "${GALLERY_STACK}" \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
        S3BucketName="${S3_BUCKET}" \
        LambdaCodeS3Key="lambda/gallery.zip" \
    --region "${REGION}" \
    --no-fail-on-empty-changeset

# Get API Gateway URL from stack output
API_URL=$(aws cloudformation describe-stacks \
    --stack-name "${GALLERY_STACK}" \
    --query 'Stacks[0].Outputs[?OutputKey==`GalleryApiUrl`].OutputValue' \
    --output text \
    --region "${REGION}")
echo "  API URL: ${API_URL}"

# Step 4: Sync frontend files to S3
echo ""
echo "[4/6] Syncing frontend to S3..."
if [[ -d "${PROJECT_DIR}/gallery" ]]; then
    aws s3 sync "${PROJECT_DIR}/gallery/" "s3://${S3_BUCKET}/gallery/" \
        --delete \
        --exclude '*.DS_Store' \
        --region "${REGION}"
else
    echo "  WARNING: gallery/ directory not found, skipping frontend sync"
fi

# Step 5: Update CloudFront stack
echo ""
echo "[5/6] Updating CloudFront distribution..."
aws cloudformation deploy \
    --template-file "${SCRIPT_DIR}/cloudfront.yml" \
    --stack-name "${CF_STACK}" \
    --parameter-overrides \
        BasicAuthUser="${BASIC_AUTH_USER}" \
        BasicAuthPass="${BASIC_AUTH_PASS}" \
        ALBDnsName="${ALB_DNS_NAME}" \
        S3BucketName="${S3_BUCKET}" \
        GalleryLambdaUrl="${API_URL}" \
    --region "${REGION}" \
    --no-fail-on-empty-changeset

# Step 6: Configure S3 event notification for zip extraction
echo ""
echo "[6/6] Configuring S3 event notification..."
LAMBDA_ARN=$(aws cloudformation describe-stacks \
    --stack-name "${GALLERY_STACK}" \
    --query 'Stacks[0].Outputs[?OutputKey==`GalleryLambdaArn`].OutputValue' \
    --output text \
    --region "${REGION}")

# Put notification configuration (S3 -> Lambda on experiments/*.zip PUT)
aws s3api put-bucket-notification-configuration \
    --bucket "${S3_BUCKET}" \
    --notification-configuration "{
        \"LambdaFunctionConfigurations\": [
            {
                \"LambdaFunctionArn\": \"${LAMBDA_ARN}\",
                \"Events\": [\"s3:ObjectCreated:*\"],
                \"Filter\": {
                    \"Key\": {
                        \"FilterRules\": [
                            {\"Name\": \"prefix\", \"Value\": \"experiments/\"},
                            {\"Name\": \"suffix\", \"Value\": \".zip\"}
                        ]
                    }
                }
            }
        ]
    }" \
    --region "${REGION}"

# Invalidate CloudFront cache for gallery
echo ""
echo "Invalidating CloudFront cache..."
CF_DIST_ID=$(aws cloudformation describe-stacks \
    --stack-name "${CF_STACK}" \
    --query 'Stacks[0].Outputs[?OutputKey==`CloudFrontDistributionId`].OutputValue' \
    --output text \
    --region "${REGION}")

aws cloudfront create-invalidation \
    --distribution-id "${CF_DIST_ID}" \
    --paths "/gallery/*" "/api/*" \
    --region "${REGION}" \
    --no-cli-pager

echo ""
echo "============================================"
echo "  Deploy Complete!"
echo "  Gallery URL: ${CLOUDFRONT_URL}/gallery/"
echo "============================================"
