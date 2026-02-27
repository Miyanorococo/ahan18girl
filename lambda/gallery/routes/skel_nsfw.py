"""Skeleton->NSFW regeneration pipeline API.

POST /api/skel-nsfw
  Body: {experimentId, imageName, nsfwPrompt, targetModel, seeds}
  -> Submits AWS Batch job for skeleton extraction + NSFW regen
  -> Returns {jobId, status}

GET /api/skel-nsfw-status?jobId=xxx
  -> Returns {status, images: [{full_url, thumb_url, model, seed}]}
"""

import json
import os
import time
import boto3

REGION = os.environ.get('AWS_REGION', 'us-east-1')
S3_BUCKET = os.environ.get('S3_BUCKET', 'r18-anime-assets')
BATCH_JOB_QUEUE = os.environ.get('BATCH_JOB_QUEUE', 'r18-anime-eval-queue')
BATCH_JOB_DEF = 'r18-anime-eval-job'

batch_client = boto3.client('batch', region_name=REGION)
s3_client = boto3.client('s3', region_name=REGION)

ALL_MODELS = [
    'wai-nsfw-illustrious-v16',
    'wai-nsfw-illustrious-v12',
    'wai-nsfw-illustrious-v11',
    'wai-branch-rouwei',
    'animagine-xl-4.0',
    'nova-anime-xl-il',
    'femix-hassakuxl',
]


import re as _re
_SAFE_PATH_RE = _re.compile(r'^[\w./-]+$')


def handle_start(event):
    """POST /api/skel-nsfw - Submit batch job."""
    try:
        body = json.loads(event.get('body', '{}'))
    except (json.JSONDecodeError, TypeError):
        return _response(400, {'error': 'Invalid JSON body'})

    experiment_id = body.get('experimentId', '')
    image_name = body.get('imageName', '')
    nsfw_prompt = body.get('nsfwPrompt', '')
    target_model = body.get('targetModel', 'all')
    seeds = body.get('seeds', [42, 123, 456])

    if not image_name:
        return _response(400, {'error': 'imageName is required'})

    # Validate path params
    if experiment_id and (not _SAFE_PATH_RE.match(experiment_id) or '..' in experiment_id):
        return _response(400, {'error': 'Invalid experimentId'})
    if not _SAFE_PATH_RE.match(image_name) or '..' in image_name:
        return _response(400, {'error': 'Invalid imageName'})

    # Determine models to use
    if target_model == 'all':
        models = ALL_MODELS
    else:
        models = [target_model]

    # Submit one Batch job per model
    job_ids = []
    timestamp = int(time.time())

    for model in models:
        for seed in seeds:
            job_name = f"skel-nsfw-{model.split('-')[0]}-s{seed}-{timestamp}"[:128]

            env_vars = [
                {'name': 'RUN_MODE', 'value': 'layer2'},
                {'name': 'MODEL_NAME', 'value': model},
                {'name': 'LAYER2_TESTS', 'value': 'clothed_nsfw'},
            ]
            # Pass user inputs to Batch job
            if experiment_id:
                env_vars.append({'name': 'SOURCE_EXPERIMENT_ID', 'value': experiment_id})
            if nsfw_prompt:
                env_vars.append({'name': 'NSFW_PROMPT', 'value': nsfw_prompt[:2000]})

            try:
                response = batch_client.submit_job(
                    jobName=job_name,
                    jobQueue=BATCH_JOB_QUEUE,
                    jobDefinition=BATCH_JOB_DEF,
                    containerOverrides={
                        'environment': env_vars,
                        'memory': 30720,
                        'vcpus': 4,
                    },
                    timeout={'attemptDurationSeconds': 7200},
                    retryStrategy={'attempts': 2},
                )
                job_ids.append({
                    'jobId': response['jobId'],
                    'model': model,
                    'seed': seed,
                })
            except Exception as e:
                print(f"Failed to submit job for {model}: {e}")

    if not job_ids:
        return _response(500, {'error': 'Failed to submit any jobs'})

    # Store job tracking info in S3
    tracking = {
        'experimentId': experiment_id,
        'imageName': image_name,
        'nsfwPrompt': nsfw_prompt,
        'jobs': job_ids,
        'createdAt': timestamp,
        'status': 'SUBMITTED',
    }

    tracking_key = f"gallery/skel-nsfw-jobs/{timestamp}.json"
    s3_client.put_object(
        Bucket=S3_BUCKET,
        Key=tracking_key,
        Body=json.dumps(tracking),
        ContentType='application/json',
    )

    return _response(200, {
        'jobId': str(timestamp),  # Use timestamp as composite job ID
        'status': 'SUBMITTED',
        'jobCount': len(job_ids),
        'models': [j['model'] for j in job_ids],
    })


def handle_status(event):
    """GET /api/skel-nsfw-status?jobId=xxx"""
    params = event.get('queryStringParameters', {}) or {}
    job_id = params.get('jobId', '')

    if not job_id:
        return _response(400, {'error': 'jobId is required'})

    # Load tracking info
    tracking_key = f"gallery/skel-nsfw-jobs/{job_id}.json"
    try:
        obj = s3_client.get_object(Bucket=S3_BUCKET, Key=tracking_key)
        tracking = json.loads(obj['Body'].read())
    except Exception:
        return _response(404, {'error': 'Job not found'})

    # Check all batch jobs
    batch_job_ids = [j['jobId'] for j in tracking['jobs']]

    try:
        # describe_jobs accepts max 100 IDs per call; paginate if needed
        jobs = []
        for i in range(0, len(batch_job_ids), 100):
            chunk = batch_job_ids[i:i + 100]
            response = batch_client.describe_jobs(jobs=chunk)
            jobs.extend(response.get('jobs', []))
    except Exception as e:
        return _response(500, {'error': 'Failed to check jobs'})

    # Aggregate status
    statuses = [j.get('status', 'UNKNOWN') for j in jobs]

    if all(s in ('SUCCEEDED', 'FAILED') for s in statuses):
        overall = 'SUCCEEDED' if any(s == 'SUCCEEDED' for s in statuses) else 'FAILED'
    elif any(s == 'FAILED' for s in statuses):
        overall = 'PARTIAL'
    else:
        overall = 'RUNNING'

    # Collect result images from S3 (if any completed)
    images = []
    if overall in ('SUCCEEDED', 'PARTIAL'):
        # Derive output paths from tracked models (not hardcoded)
        tracked_models = set(j.get('model', '') for j in tracking.get('jobs', []))
        for model in tracked_models:
            # Output path convention: layer2-{model}/ (or layer2/ for default wai-nsfw-v16)
            if model == 'wai-nsfw-illustrious-v16':
                prefix_path = 'layer2'
            else:
                prefix_path = f"layer2-{model}"

            try:
                resp = s3_client.list_objects_v2(
                    Bucket=S3_BUCKET,
                    Prefix=f"gallery/experiments/{prefix_path}/clothed_nsfw/clothed_to_nsfw/full/nsfw_",
                    MaxKeys=100,
                )
                for obj in resp.get('Contents', []):
                    key = obj['Key']
                    filename = key.split('/')[-1]
                    images.append({
                        'full_url': f"/gallery/experiments/{prefix_path}/clothed_nsfw/clothed_to_nsfw/full/{filename}",
                        'thumb_url': f"/gallery/experiments/{prefix_path}/clothed_nsfw/clothed_to_nsfw/thumb/{filename.replace('.png', '.webp')}",
                        'model': model,
                        'filename': filename,
                    })
            except Exception:
                pass

    return _response(200, {
        'status': overall,
        'jobs': len(batch_job_ids),
        'succeeded': statuses.count('SUCCEEDED'),
        'failed': statuses.count('FAILED'),
        'running': len([s for s in statuses if s not in ('SUCCEEDED', 'FAILED')]),
        'images': images,
    })


def _response(code, body):
    return {
        'statusCode': code,
        'headers': {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': os.environ.get('CORS_ORIGIN', 'https://d2m524k99quzzr.cloudfront.net'),
        },
        'body': json.dumps(body),
    }
