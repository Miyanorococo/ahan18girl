import json
import logging
import os
import re
from datetime import datetime, timezone

import boto3

from services.s3_client import S3Client

logger = logging.getLogger(__name__)

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
}

REGION = os.environ.get("AWS_REGION", "us-east-1")
STATE_MACHINE_ARN = (
    "arn:aws:states:us-east-1:028395298019:stateMachine:r18-anime-eval"
)

# Production model groups (7 models across 4 groups)
MODEL_GROUPS = {
    "A_illustrious": {
        "models": [
            "wai-nsfw-illustrious-v16",
            "wai-nsfw-illustrious-v11",
            "wai-branch-rouwei",
            "wai-nsfw-illustrious-v12",
        ],
        "cfg": 7,
        "steps": 25,
        "sampler": "euler_ancestral",
        "scheduler": "sgm_uniform",
        "clip_skip": 2,
        "resolution": {"width": 1024, "height": 1536},
        "quality_prefix": "masterpiece, best quality, amazing quality, high score, great score, ",
        "quality_suffix": "",
        "negative": "bad quality, worst quality, worst detail, sketch, bad anatomy, bad hands, extra digits",
    },
    "D_animagine": {
        "models": ["animagine-xl-4.0"],
        "cfg": 7,
        "steps": 25,
        "sampler": "euler_ancestral",
        "scheduler": "normal",
        "clip_skip": 2,
        "resolution": {"width": 1024, "height": 1536},
        "quality_prefix": "masterpiece, best quality, very aesthetic, absurdres, ",
        "quality_suffix": "",
        "negative": "(worst quality:1.2), bad anatomy, bad hands, extra digits, fewer digits",
        "strip_tags": [
            "warm lighting", "soft lighting", "soft shadows",
            "afternoon light", "classroom light", "golden hour light",
            "candlelight", "warm candlelight", "bioluminescent glow",
            "afternoon sunlight", "golden hour",
            "from front", "from above", "from below", "from side", "from behind",
            "dynamic angle", "low angle",
            "close-up", "cowboy shot", "full body", "upper body",
            "smooth skin", "wet skin", "glistening skin", "detailed skin",
            "skin texture", "subsurface scattering", "natural skin texture",
            "skin pores",
        ],
    },
    "B_nova": {
        "models": ["nova-anime-xl-il"],
        "cfg": 7,
        "steps": 25,
        "sampler": "euler_ancestral",
        "scheduler": "sgm_uniform",
        "clip_skip": 2,
        "resolution": {"width": 1024, "height": 1536},
        "quality_prefix": "masterpiece, best quality, amazing quality, high score, great score, ",
        "quality_suffix": "",
        "negative": "bad quality, worst quality, bad anatomy, bad hands",
    },
    "E_femix": {
        "models": ["femix-hassakuxl"],
        "cfg": 7,
        "steps": 25,
        "sampler": "euler_ancestral",
        "scheduler": "sgm_uniform",
        "clip_skip": 2,
        "resolution": {"width": 1024, "height": 1536},
        "quality_prefix": "masterpiece, best quality, amazing quality, high score, great score, ",
        "quality_suffix": "",
        "negative": "bad quality, worst quality, worst detail, sketch, bad anatomy, bad hands, extra digits",
    },
}

# Common negative prompts by type
NEGATIVE_COMMON = {
    "explicit": "censored, mosaic censoring, bar censor, ",
    "sensitive": "censored, ",
    "safe": "",
}


def _response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": CORS_HEADERS,
        "body": json.dumps(body, ensure_ascii=False),
    }


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _detect_next_generation(s3, book_id):
    """Scan existing experiments for this book to find the highest R{n} prefix, return n+1.

    Looks at experiment directories under experiments/ in S3 to find prompt_ids
    that contain R{n}_ prefixes for this book.
    Returns 2 if no regen generations exist yet (R1 = original, R2 = first regen).
    """

    max_gen = 0  # Start at 0 so first regen is R1
    prefix = "gallery/experiments/"

    try:
        # List all experiment directories
        s3_client = boto3.client("s3", region_name=REGION)
        bucket = s3.bucket

        paginator = s3_client.get_paginator("list_objects_v2")
        # Look for metadata.json files that might contain R{n}_ prompt_ids
        for page in paginator.paginate(
            Bucket=bucket, Prefix=prefix, Delimiter="/"
        ):
            for cp in page.get("CommonPrefixes", []):
                dir_name = cp["Prefix"].replace(prefix, "").rstrip("/")
                # Check if directory name contains the book_id and R{n}_ pattern
                # Experiment dir format: "20260216_model/prompt_id"
                # The prompt_id part might be like "0216a_R1_S08f_climax"
                rn_match = re.search(
                    rf"{re.escape(book_id)}_R(\d+)_", dir_name
                )
                if rn_match:
                    gen_num = int(rn_match.group(1))
                    if gen_num > max_gen:
                        max_gen = gen_num

        # Also scan inside experiment directories for prompt_ids in metadata
        # by listing objects that match the bookId pattern more broadly
        for page in paginator.paginate(
            Bucket=bucket, Prefix=prefix
        ):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if not key.endswith("metadata.json"):
                    continue
                # Check if the path contains R{n}_ for this book
                rn_match = re.search(
                    rf"{re.escape(book_id)}_R(\d+)_", key
                )
                if rn_match:
                    gen_num = int(rn_match.group(1))
                    if gen_num > max_gen:
                        max_gen = gen_num

    except Exception as e:
        logger.warning("Failed to scan for existing generations: %s", e)

    next_gen = max_gen + 1
    logger.info(
        "Book %s: highest existing generation = R%d, next = R%d",
        book_id, max_gen, next_gen,
    )
    return next_gen


def start_regeneration(event):
    """POST /api/regenerate - Build prompt file, upload to S3, start Step Functions."""
    body = event.get("body", "{}")
    if event.get("isBase64Encoded"):
        import base64
        body = base64.b64decode(body).decode("utf-8")

    try:
        data = json.loads(body) if isinstance(body, str) else body
    except json.JSONDecodeError:
        return _response(400, {"error": "Invalid JSON body"})

    book_id = data.get("bookId", "")
    pages = data.get("pages", [])
    requested_models = data.get("models", [])
    seeds = data.get("seeds", [42, 123, 456])

    if not pages:
        return _response(400, {"error": "pages list is required"})
    if not book_id:
        return _response(400, {"error": "bookId is required"})

    s3 = S3Client()

    # Auto-detect next generation number
    generation = _detect_next_generation(s3, book_id)
    gen_prefix = f"R{generation}"
    logger.info("Using generation prefix: %s", gen_prefix)

    # Build prompts array from flagged pages, prefixing each pageId with R{n}_
    prompts = []
    for page in pages:
        page_id = page.get("pageId", "")
        prompt_text = page.get("prompt", "")
        genre = page.get("genre", "")
        prompt_type = page.get("type", "sensitive")

        if not page_id or not prompt_text:
            continue

        # Prefix the page_id: "0216a_S08f_climax" -> "0216a_R1_S08f_climax"
        # Insert R{n}_ after the bookId prefix
        regen_id = re.sub(
            rf"^({re.escape(book_id)})_",
            rf"\1_{gen_prefix}_",
            page_id,
        )
        # If the page_id didn't start with bookId_ (legacy), just prepend
        if regen_id == page_id:
            regen_id = f"{book_id}_{gen_prefix}_{page_id}"

        prompts.append({
            "id": regen_id,
            "genre": genre,
            "type": prompt_type,
            "subtype": "regen",
            "content": {
                "default": prompt_text,
            },
        })

    if not prompts:
        return _response(400, {"error": "No valid prompts to regenerate"})

    # Determine which models to run
    if requested_models:
        # Filter model_groups to only include requested models
        filtered_groups = {}
        for group_key, group in MODEL_GROUPS.items():
            matching_models = [m for m in group["models"] if m in requested_models]
            if matching_models:
                filtered_groups[group_key] = {**group, "models": matching_models}
        model_groups = filtered_groups if filtered_groups else MODEL_GROUPS
    else:
        model_groups = MODEL_GROUPS

    # Collect all model names for Step Functions input
    all_models = []
    for group in model_groups.values():
        all_models.extend(group["models"])

    # Build the prompt file (same format as eval-prompts-prod-*.json)
    prompt_file = {
        "_meta": {
            "description": f"Regeneration for book {book_id} (Gen {generation})",
            "created": _now_iso(),
            "version": f"regen-{book_id}-R{generation}",
            "seeds": seeds,
            "note": f"UI-triggered regeneration: {len(prompts)} pages (generation {generation})",
            "book_id": book_id,
            "generation": generation,
        },
        "negative_common": NEGATIVE_COMMON,
        "model_groups": model_groups,
        "prompts": prompts,
    }

    try:
        # Upload the regen prompt file
        regen_key = f"eval-scripts/eval-prompts-regen-{book_id}.json"
        s3.put_json(regen_key, prompt_file)
        logger.info("Uploaded regen prompts to %s", regen_key)

        # Copy to eval-prompts.json so batch workers pick it up
        active_key = "eval-scripts/eval-prompts.json"
        s3.put_json(active_key, prompt_file)
        logger.info("Copied regen prompts to %s", active_key)
    except Exception as e:
        logger.error("Failed to upload prompt file: %s", e)
        return _response(500, {"error": f"Failed to upload prompt file: {e}"})

    # Start Step Functions execution
    try:
        sfn = boto3.client("stepfunctions", region_name=REGION)

        models_input = [
            {"model": model, "jobName": model.replace(".", "-")}
            for model in all_models
        ]

        exec_name = f"regen-{book_id}-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
        sfn_input = json.dumps({"models": models_input})

        result = sfn.start_execution(
            stateMachineArn=STATE_MACHINE_ARN,
            name=exec_name,
            input=sfn_input,
        )

        execution_arn = result["executionArn"]
        logger.info(
            "Started Step Functions execution: %s (arn: %s)",
            exec_name, execution_arn,
        )

        return _response(200, {
            "status": "started",
            "executionName": exec_name,
            "executionArn": execution_arn,
            "models": all_models,
            "promptCount": len(prompts),
            "seeds": seeds,
            "generation": generation,
        })
    except Exception as e:
        logger.error("Failed to start Step Functions: %s", e)
        return _response(500, {"error": f"Failed to start Step Functions: {e}"})


def get_regeneration_status(event):
    """GET /api/regenerate-status?arn=... - Check Step Functions execution status."""
    qs = event.get("queryStringParameters") or {}
    execution_arn = qs.get("arn", "")

    if not execution_arn:
        return _response(400, {"error": "arn query parameter is required"})

    try:
        sfn = boto3.client("stepfunctions", region_name=REGION)
        result = sfn.describe_execution(executionArn=execution_arn)

        status = result.get("status", "UNKNOWN")
        response_body = {
            "status": status,
            "executionArn": execution_arn,
            "name": result.get("name", ""),
        }

        if result.get("startDate"):
            response_body["startDate"] = result["startDate"].isoformat()
        if result.get("stopDate"):
            response_body["stopDate"] = result["stopDate"].isoformat()

        return _response(200, response_body)
    except Exception as e:
        logger.error("Failed to describe execution: %s", e)
        return _response(500, {"error": f"Failed to check status: {e}"})
