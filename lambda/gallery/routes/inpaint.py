import json
import logging
import os
import re
from datetime import datetime, timezone

import boto3

from services.s3_client import S3Client

logger = logging.getLogger(__name__)

_SAFE_PATH_RE = re.compile(r'^[\w./-]+$')

def _validate_path_param(value):
    """Reject path-traversal or suspicious path parameters."""
    return bool(value) and '..' not in value and _SAFE_PATH_RE.match(value)

CORS_HEADERS = {
    "Access-Control-Allow-Origin": os.environ.get("CORS_ORIGIN", "https://d2m524k99quzzr.cloudfront.net"),
    "Content-Type": "application/json",
}

REGION = os.environ.get("AWS_REGION", "us-east-1")
BATCH_JOB_QUEUE = os.environ.get("BATCH_JOB_QUEUE", "r18-anime-eval-queue")
BATCH_JOB_DEFINITION = os.environ.get("BATCH_JOB_DEFINITION", "r18-anime-eval-job")
S3_BUCKET = os.environ.get("S3_BUCKET", "r18-anime-assets")

# Checkpoint filename mapping (short name -> full filename)
CHECKPOINT_MAP = {
    "wai-nsfw-illustrious-v16": "wai-nsfw-illustrious-v16.safetensors",
    "wai-nsfw-illustrious-v12": "wai-nsfw-illustrious-v12.safetensors",
    "wai-nsfw-illustrious-v11": "wai-nsfw-illustrious-v11.safetensors",
    "wai-branch-rouwei": "wai-branch-rouwei.safetensors",
    "animagine-xl-4.0": "animagine-xl-4.0-opt.safetensors",
    "nova-anime-xl-il": "novaAnimeXL_ilV10.safetensors",
    "femix-hassakuxl": "femix-hassakuxl.safetensors",
}


def _detect_next_generation(s3, book_id, date_model_prefix):
    """Scan S3 to find the next available generation number for this book+model."""
    try:
        prefix = f"gallery/experiments/{date_model_prefix}/"
        keys = s3.list_objects(prefix)
        max_gen = 0
        for key in keys:
            match = re.search(rf"{book_id}_R(\d+)_", key)
            if match:
                gen = int(match.group(1))
                max_gen = max(max_gen, gen)
        return max_gen + 1
    except Exception as e:
        logger.warning("Failed to detect generation: %s", e)
        return 1


def _response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": CORS_HEADERS,
        "body": json.dumps(body, ensure_ascii=False),
    }


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def submit_inpaint(event):
    """POST /api/inpaint - Submit an inpaint Batch job.

    Body:
        experiment_id: str - source experiment ID (e.g. "20260219_wai-nsfw-illustrious-v16/0219a_S00_cover")
        image_name: str - image filename (e.g. "seed42.png")
        workflow: str - "face" | "region" | "hand" | "upscale"
        prompt: str - prompt for the workflow
        negative: str - negative prompt (optional)
        checkpoint: str - model checkpoint filename (optional, auto-detected from experiment_id)
        seed: int - random seed (optional, auto-detected from image_name)
        denoise: float - denoise strength (optional, defaults per workflow)
        scale: int - upscale factor for 'upscale' workflow (optional, default 2)
    """
    body = event.get("body", "{}")
    if event.get("isBase64Encoded"):
        import base64
        body = base64.b64decode(body).decode("utf-8")

    try:
        data = json.loads(body) if isinstance(body, str) else body
    except json.JSONDecodeError:
        return _response(400, {"error": "Invalid JSON body"})

    experiment_id = data.get("experiment_id", "")
    image_name = data.get("image_name", "")
    workflow = data.get("workflow", "")
    prompt = data.get("prompt", "")
    negative = data.get("negative", "bad quality, worst quality")
    checkpoint = data.get("checkpoint", "")
    seed = data.get("seed", 42)
    denoise = data.get("denoise")
    scale = data.get("scale", 2)
    mask_data = data.get("mask_data")  # base64 PNG data URL for region workflow

    if not _validate_path_param(experiment_id):
        return _response(400, {"error": "Invalid experiment_id"})
    if not _validate_path_param(image_name):
        return _response(400, {"error": "Invalid image_name"})
    if workflow not in ("face", "region", "hand", "upscale"):
        return _response(400, {"error": f"Invalid workflow: {workflow}. Must be face|region|hand|upscale"})

    # Auto-detect checkpoint from experiment_id if not provided
    if not checkpoint:
        # experiment_id format: "20260219_wai-nsfw-illustrious-v16/0219a_S00_cover"
        # Strip -pp suffix before matching
        exp_id_clean = experiment_id.replace("-pp/", "/").replace("-pp", "")
        for model_key, ckpt_file in CHECKPOINT_MAP.items():
            if model_key in exp_id_clean:
                checkpoint = ckpt_file
                break
        if not checkpoint:
            checkpoint = "wai-nsfw-illustrious-v16.safetensors"

    # Ensure checkpoint has .safetensors extension
    if not checkpoint.endswith(".safetensors"):
        checkpoint = CHECKPOINT_MAP.get(checkpoint, checkpoint + ".safetensors")

    # Auto-detect seed from image_name
    if not seed or seed == 42:
        seed_match = re.search(r"seed[_-]?(\d+)", image_name, re.IGNORECASE)
        if seed_match:
            seed = int(seed_match.group(1))

    # Default denoise per workflow
    if denoise is None:
        denoise = {"face": 0.4, "region": 0.35, "hand": 0.65, "upscale": 0.15}.get(workflow, 0.35)

    # Build output experiment ID using Regen-compatible generation format
    # This ensures inpaint results appear in the Book Editor's Candidates as R1/R2/etc.
    # experiment_id format: "20260219_wai-nsfw-illustrious-v16/0219a_S00_cover"
    parts = experiment_id.split("/")
    if len(parts) == 2:
        date_model = parts[0]  # "20260219_wai-nsfw-illustrious-v16"
        prompt_id = parts[1]   # "0219a_S00_cover"
        # Extract book_id from prompt_id: "0219a" from "0219a_S00_cover"
        # Supports: MMDDx (4 digits + letter), MMDDxx (multi-letter), custom prefixes
        book_match = re.match(r"(\d{4}[a-z]+)", prompt_id)
        book_id = book_match.group(1) if book_match else ""
        # Detect next generation number from index
        s3_client = S3Client()
        next_gen = _detect_next_generation(s3_client, book_id, date_model)
        # Build regen-compatible prompt_id: "0219a_R1_S00_cover"
        scene_part = re.sub(r"^\d{4}[a-z]+_", "", prompt_id)  # "S00_cover"
        regen_prompt_id = f"{book_id}_R{next_gen}_{scene_part}"
        output_experiment_id = f"{date_model}/{regen_prompt_id}"
    else:
        output_experiment_id = f"{experiment_id}_inpaint"

    # Source image S3 key
    source_image_key = f"gallery/experiments/{experiment_id}/full/{image_name}"

    # Build inpaint job config and upload to S3
    job_config = {
        "experiment_id": experiment_id,
        "output_experiment_id": output_experiment_id,
        "image_name": image_name,
        "source_image_key": source_image_key,
        "workflow": workflow,
        "prompt": prompt,
        "negative": negative,
        "checkpoint": checkpoint,
        "seed": seed,
        "denoise": denoise,
        "scale": scale,
        "created_at": _now_iso(),
    }

    s3 = S3Client()
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")

    # Upload mask image to S3 if provided (region workflow)
    if mask_data:
        import base64 as b64_mod

        # Strip data URL prefix (e.g. "data:image/png;base64,...")
        if "," in mask_data:
            mask_data = mask_data.split(",", 1)[1]
        try:
            mask_bytes = b64_mod.b64decode(mask_data)
            mask_key = f"eval-scripts/inpaint-masks/{timestamp}_{image_name.replace('.png', '_mask.png')}"
            s3.put_object(mask_key, mask_bytes, content_type="image/png")
            job_config["mask_s3_key"] = mask_key
            logger.info("Uploaded mask image to %s", mask_key)
        except Exception as e:
            logger.error("Failed to upload mask image: %s", e)
            return _response(500, {"error": "Failed to upload mask"})

    config_key = f"eval-scripts/inpaint-jobs/{timestamp}_{workflow}_{image_name.replace('.', '_')}.json"

    try:
        s3.put_json(config_key, job_config)
        logger.info("Uploaded inpaint config to %s", config_key)
    except Exception as e:
        logger.error("Failed to upload inpaint config: %s", e)
        return _response(500, {"error": "Failed to upload config"})

    # Submit Batch job
    try:
        batch = boto3.client("batch", region_name=REGION)

        job_name = f"inpaint-{workflow}-{timestamp}".replace(".", "-")[:128]

        container_overrides = {
            "environment": [
                {"name": "RUN_MODE", "value": "inpaint"},
                {"name": "INPAINT_CONFIG_KEY", "value": config_key},
                {"name": "S3_BUCKET", "value": S3_BUCKET},
            ],
            "memory": 30720,  # 30 GB
            "vcpus": 4,
        }

        result = batch.submit_job(
            jobName=job_name,
            jobQueue=BATCH_JOB_QUEUE,
            jobDefinition=BATCH_JOB_DEFINITION,
            containerOverrides=container_overrides,
        )

        job_id = result["jobId"]
        logger.info("Submitted Batch job: %s (id: %s)", job_name, job_id)

        return _response(200, {
            "status": "submitted",
            "jobId": job_id,
            "jobName": job_name,
            "workflow": workflow,
            "configKey": config_key,
            "outputExperimentId": output_experiment_id,
        })

    except Exception as e:
        logger.error("Failed to submit Batch job: %s", e)
        return _response(500, {"error": "Failed to submit job"})


def get_inpaint_status(event):
    """GET /api/inpaint-status?jobId=... - Check Batch job status."""
    qs = event.get("queryStringParameters") or {}
    job_id = qs.get("jobId", "")

    if not job_id:
        return _response(400, {"error": "jobId query parameter is required"})

    try:
        batch = boto3.client("batch", region_name=REGION)
        result = batch.describe_jobs(jobs=[job_id])

        jobs = result.get("jobs", [])
        if not jobs:
            return _response(404, {"error": f"Job not found: {job_id}"})

        job = jobs[0]
        status = job.get("status", "UNKNOWN")

        response_body = {
            "status": status,
            "jobId": job_id,
            "jobName": job.get("jobName", ""),
        }

        if job.get("startedAt"):
            response_body["startedAt"] = datetime.fromtimestamp(
                job["startedAt"] / 1000, tz=timezone.utc
            ).isoformat()
        if job.get("stoppedAt"):
            response_body["stoppedAt"] = datetime.fromtimestamp(
                job["stoppedAt"] / 1000, tz=timezone.utc
            ).isoformat()
        if job.get("statusReason"):
            response_body["reason"] = job["statusReason"]

        # If succeeded, try to get the output URL
        if status == "SUCCEEDED":
            # The inpaint script saves to output_experiment_id
            # Try to find the output in the config
            try:
                env_vars = {
                    e["name"]: e["value"]
                    for e in job.get("container", {}).get("environment", [])
                }
                config_key = env_vars.get("INPAINT_CONFIG_KEY", "")
                if config_key:
                    s3 = S3Client()
                    config = s3.get_json(config_key)
                    output_exp = config.get("output_experiment_id", "")
                    img_name = config.get("image_name", "")
                    if output_exp and img_name:
                        response_body["outputUrl"] = (
                            f"/gallery/experiments/{output_exp}/full/{img_name}"
                        )
            except Exception:
                pass  # Non-critical

        return _response(200, response_body)

    except Exception as e:
        logger.error("Failed to describe Batch job: %s", e)
        return _response(500, {"error": "Failed to check job status"})
