#!/usr/bin/env python3
"""
Batch evaluation image generator for 13-model comparison.

Reads eval-prompts.json and generates images via ComfyUI API,
then uploads to S3 in the gallery-compatible format.

Usage:
    python generate-eval.py [--dry-run] [--models MODEL1,MODEL2,...] [--prompts P01_ex,P02_se,...]
    python generate-eval.py --status  # Check ComfyUI status

Environment:
    COMFYUI_URL    ComfyUI API URL (default: http://127.0.0.1:8188)
    S3_BUCKET      S3 bucket name (default: r18-anime-assets)
    PROMPTS_FILE   Path to eval-prompts.json
"""

import argparse
import io
import json
import logging
import os
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

try:
    import boto3
except ImportError:
    boto3 = None

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("generate-eval")

COMFYUI_URL = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")
S3_BUCKET = os.environ.get("S3_BUCKET", "r18-anime-assets")
PROMPTS_FILE = os.environ.get(
    "PROMPTS_FILE",
    str(Path(__file__).parent.parent / "assets" / "templates" / "eval-prompts.json"),
)
OUTPUT_DIR = os.environ.get("OUTPUT_DIR", "/data/ComfyUI/output/eval")
GALLERY_PREFIX = "gallery/experiments"


# ---------------------------------------------------------------------------
# ComfyUI API helpers
# ---------------------------------------------------------------------------

def comfyui_api(path, method="GET", data=None):
    """Send a request to ComfyUI API."""
    url = f"{COMFYUI_URL}{path}"
    headers = {"Content-Type": "application/json"} if data else {}
    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return json.loads(resp.read())
    except urllib.error.URLError as e:
        log.error("ComfyUI API error: %s (url: %s)", e, url)
        raise


def check_status():
    """Check ComfyUI is running and show system stats."""
    try:
        stats = comfyui_api("/system_stats")
        devices = stats.get("devices", [])
        for d in devices:
            name = d.get("name", "unknown")
            vram_total = d.get("vram_total", 0) / (1024**3)
            vram_free = d.get("vram_free", 0) / (1024**3)
            log.info("GPU: %s  VRAM: %.1fGB / %.1fGB", name, vram_total - vram_free, vram_total)
        return True
    except Exception as e:
        log.error("ComfyUI not reachable: %s", e)
        return False


def queue_prompt(workflow_json):
    """Queue a prompt and return the prompt_id."""
    resp = comfyui_api("/prompt", method="POST", data={"prompt": workflow_json})
    return resp.get("prompt_id")


def wait_for_completion(prompt_id, timeout=300):
    """Poll history until the prompt completes."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            history = comfyui_api(f"/history/{prompt_id}")
            if prompt_id in history:
                return history[prompt_id]
        except Exception:
            pass
        time.sleep(2)
    raise TimeoutError(f"Prompt {prompt_id} did not complete within {timeout}s")


def get_image(filename, subfolder, folder_type="output"):
    """Download a generated image from ComfyUI."""
    params = urllib.parse.urlencode({
        "filename": filename,
        "subfolder": subfolder,
        "type": folder_type,
    })
    url = f"{COMFYUI_URL}/view?{params}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


# ---------------------------------------------------------------------------
# Workflow builder
# ---------------------------------------------------------------------------

def build_txt2img_workflow(
    checkpoint, positive, negative, seed, width, height,
    steps, cfg, sampler, scheduler, clip_skip
):
    """Build a minimal ComfyUI txt2img workflow JSON (API format)."""
    workflow = {
        "1": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": checkpoint},
        },
        "2": {
            "class_type": "CLIPSetLastLayer",
            "inputs": {
                "clip": ["1", 1],
                "stop_at_clip_layer": -clip_skip,
            },
        },
        "3": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "clip": ["2", 0],
                "text": positive,
            },
        },
        "4": {
            "class_type": "CLIPTextEncode",
            "inputs": {
                "clip": ["2", 0],
                "text": negative,
            },
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {
                "width": width,
                "height": height,
                "batch_size": 1,
            },
        },
        "6": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["1", 0],
                "positive": ["3", 0],
                "negative": ["4", 0],
                "latent_image": ["5", 0],
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": sampler,
                "scheduler": scheduler,
                "denoise": 1.0,
            },
        },
        "7": {
            "class_type": "VAEDecode",
            "inputs": {
                "samples": ["6", 0],
                "vae": ["1", 2],
            },
        },
        "8": {
            "class_type": "SaveImage",
            "inputs": {
                "images": ["7", 0],
                "filename_prefix": "eval",
            },
        },
    }
    return workflow


# ---------------------------------------------------------------------------
# Prompt assembly
# ---------------------------------------------------------------------------

def load_prompts(path):
    """Load eval-prompts.json."""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_model_group(config, checkpoint_name):
    """Find the model group for a given checkpoint filename."""
    for group_key, group in config["model_groups"].items():
        for model in group["models"]:
            if model in checkpoint_name:
                return group_key, group
    return None, None


def assemble_prompt(config, group_key, group, prompt_entry):
    """Assemble the final positive prompt from group prefix/suffix + content variant."""
    content = prompt_entry["content"]
    prompt_type = prompt_entry.get("type", "explicit")

    # Select the correct content variant
    if group_key in content:
        body = content[group_key]
    elif group_key.startswith("A") and "default" in content:
        body = content["default"]
    elif group_key.startswith("B") and "default" in content:
        body = content["default"]
    elif group_key.startswith("E") and "default" in content:
        body = content["default"]
    else:
        body = content.get("default", "")

    positive = group["quality_prefix"] + body + group["quality_suffix"]

    # Assemble negative: type-specific prefix + group negative
    neg_common = config.get("negative_common", {})
    neg_prefix = neg_common.get(prompt_type, "")
    negative = neg_prefix + group["negative"]

    return positive.strip(", "), negative.strip(", ")


# ---------------------------------------------------------------------------
# S3 upload
# ---------------------------------------------------------------------------

def upload_to_s3(bucket, experiment_id, images, metadata):
    """Upload images and metadata to S3 in gallery-compatible format."""
    if not boto3:
        log.warning("boto3 not available, skipping S3 upload")
        return

    s3 = boto3.client("s3")
    base = f"{GALLERY_PREFIX}/{experiment_id}"

    # Upload metadata
    meta_key = f"{base}/metadata.json"
    s3.put_object(
        Bucket=bucket,
        Key=meta_key,
        Body=json.dumps(metadata, ensure_ascii=False, indent=2).encode(),
        ContentType="application/json",
    )

    # Upload images to full/ and create thumbnails in thumb/
    for img_name, img_data in images:
        full_key = f"{base}/full/{img_name}"
        s3.put_object(
            Bucket=bucket, Key=full_key, Body=img_data, ContentType="image/png"
        )
        thumb_key = f"{base}/thumb/{img_name}"
        s3.put_object(
            Bucket=bucket, Key=thumb_key, Body=img_data, ContentType="image/png"
        )

    log.info("Uploaded %d images to %s", len(images), base)


def rebuild_gallery_index(bucket):
    """Scan all metadata.json files in S3 and rebuild gallery index.json."""
    if not boto3:
        log.error("boto3 required for index rebuild")
        return

    s3 = boto3.client("s3")
    prefix = f"{GALLERY_PREFIX}/"
    index = []

    # List all metadata.json files
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if not key.endswith("/metadata.json"):
                continue

            try:
                resp = s3.get_object(Bucket=bucket, Key=key)
                meta = json.loads(resp["Body"].read())
            except Exception as e:
                log.warning("Failed to read %s: %s", key, e)
                continue

            # Extract experiment ID from path
            # gallery/experiments/{date}_{model}/{prompt_id}/metadata.json
            exp_id = key[len(prefix):-len("/metadata.json")]

            # Count images
            img_prefix = f"{prefix}{exp_id}/full/"
            img_resp = s3.list_objects_v2(Bucket=bucket, Prefix=img_prefix, MaxKeys=100)
            image_count = img_resp.get("KeyCount", 0)

            # Find first thumbnail
            thumb_prefix = f"{prefix}{exp_id}/thumb/"
            thumb_resp = s3.list_objects_v2(Bucket=bucket, Prefix=thumb_prefix, MaxKeys=1)
            thumbnail = ""
            for t in thumb_resp.get("Contents", []):
                thumbnail = f"/{t['Key']}"
                break

            entry = {
                "id": exp_id,
                "model": meta.get("model", {}).get("checkpoint", "unknown"),
                "pipeline": meta.get("pipeline", "txt2img"),
                "prompt_summary": meta.get("prompt_summary", ""),
                "date": meta.get("date", ""),
                "image_count": image_count,
                "thumbnail": thumbnail,
                "created_at": meta.get("created_at", ""),
            }
            index.append(entry)

    # Sort by created_at descending
    index.sort(key=lambda x: x.get("created_at", ""), reverse=True)

    # Upload index
    index_key = f"{GALLERY_PREFIX}/index.json"
    s3.put_object(
        Bucket=bucket,
        Key=index_key,
        Body=json.dumps(index, ensure_ascii=False, indent=2).encode(),
        ContentType="application/json",
    )
    log.info("Gallery index rebuilt: %d experiments -> %s", len(index), index_key)


# ---------------------------------------------------------------------------
# Main generation loop
# ---------------------------------------------------------------------------

CHECKPOINT_MAP = {
    "wai-nsfw-illustrious-v16": "wai-nsfw-illustrious-v16.safetensors",
    "wai-nsfw-illustrious-v14": "wai-nsfw-illustrious-v14.safetensors",
    "wai-nsfw-illustrious-v12": "wai-nsfw-illustrious-v12.safetensors",
    "wai-nsfw-illustrious-v11": "wai-nsfw-illustrious-v11.safetensors",
    "wai-branch-rouwei": "wai-branch-rouwei.safetensors",
    "illustrij-v20": "illustrij-v20.safetensors",
    "nova-anime-xl-il": "nova-anime-xl-il.safetensors",
    "autismmix-sdxl": "autismmix-sdxl.safetensors",
    "pony-diffusion-v6-xl": "pony-diffusion-v6-xl.safetensors",
    "animagine-xl-4.0": "animagine-xl-4.0.safetensors",
    "femix-hassakuxl": "femix-hassakuxl.safetensors",
    "dreamshaper-8": "dreamshaper-8.safetensors",
    "aam-anylora-anime-mix": "aam-anylora-anime-mix.safetensors",
}


def check_s3_exists(bucket, key):
    """Check if an S3 object exists."""
    if not boto3:
        return False
    try:
        s3 = boto3.client("s3")
        s3.head_object(Bucket=bucket, Key=key)
        return True
    except Exception:
        return False


def check_experiment_complete(bucket, experiment_id, expected_seeds):
    """Check if all images for an experiment already exist in S3."""
    if not boto3:
        return False
    try:
        s3 = boto3.client("s3")
        prefix = f"{GALLERY_PREFIX}/{experiment_id}/full/"
        resp = s3.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=100)
        existing = {obj["Key"].split("/")[-1] for obj in resp.get("Contents", [])}
        # Check if all seed images exist
        for seed in expected_seeds:
            # Match any file with this seed
            if not any(f"seed{seed}.png" in name for name in existing):
                return False
        return True
    except Exception:
        return False


def run_generation(config, model_filter=None, prompt_filter=None, dry_run=False, resume=True):
    """Main generation loop with resume support."""
    seeds = config["_meta"]["seeds"]
    prompts = config["prompts"]
    now = datetime.now(timezone.utc)
    date_str = now.strftime("%Y%m%d")

    total_images = 0
    total_models = 0

    for group_key, group in config["model_groups"].items():
        for model_name in group["models"]:
            if model_filter and model_name not in model_filter:
                continue

            checkpoint = CHECKPOINT_MAP.get(model_name)
            if not checkpoint:
                log.warning("No checkpoint file mapped for %s, skipping", model_name)
                continue

            total_models += 1
            log.info("=== Model: %s (%s) ===", model_name, checkpoint)

            for prompt_entry in prompts:
                prompt_id = prompt_entry["id"]
                if prompt_filter and prompt_id not in prompt_filter:
                    continue

                positive, negative = assemble_prompt(config, group_key, group, prompt_entry)
                prompt_summary = f"{prompt_entry['genre']}_{prompt_entry['type']}"

                # Experiment ID for gallery: {date}_{model}/{prompt_id}
                experiment_id = f"{date_str}_{model_name}/{prompt_id}"

                metadata = {
                    "model": {"checkpoint": model_name},
                    "pipeline": "txt2img",
                    "prompt": {"positive": positive, "negative": negative},
                    "prompt_summary": prompt_summary,
                    "parameters": {
                        "steps": group["steps"],
                        "cfg_scale": group["cfg"],
                        "sampler": group["sampler"],
                        "scheduler": group.get("scheduler", "normal"),
                        "clip_skip": group["clip_skip"],
                        "width": group["resolution"]["width"],
                        "height": group["resolution"]["height"],
                    },
                    "seeds": seeds,
                    "genre": prompt_entry["genre"],
                    "type": prompt_entry["type"],
                    "date": now.strftime("%Y-%m-%d"),
                    "created_at": now.isoformat(),
                }

                if dry_run:
                    log.info("  [DRY RUN] %s: %d images", prompt_id, len(seeds))
                    log.info("    Positive: %s", positive[:120])
                    total_images += len(seeds)
                    continue

                # Resume: skip if all images already exist in S3
                if resume and check_experiment_complete(S3_BUCKET, experiment_id, seeds):
                    log.info("  [SKIP] %s: already complete in S3", prompt_id)
                    total_images += len(seeds)
                    continue

                images = []
                for seed in seeds:
                    img_name = f"{prompt_id}_seed{seed}.png"
                    log.info("  Generating %s seed=%d ...", prompt_id, seed)

                    workflow = build_txt2img_workflow(
                        checkpoint=checkpoint,
                        positive=positive,
                        negative=negative,
                        seed=seed,
                        width=group["resolution"]["width"],
                        height=group["resolution"]["height"],
                        steps=group["steps"],
                        cfg=group["cfg"],
                        sampler=group["sampler"],
                        scheduler=group.get("scheduler", "normal"),
                        clip_skip=group["clip_skip"],
                    )

                    try:
                        pid = queue_prompt(workflow)
                        result = wait_for_completion(pid)
                        # Extract output images
                        outputs = result.get("outputs", {})
                        for node_id, node_output in outputs.items():
                            for img_info in node_output.get("images", []):
                                img_data = get_image(
                                    img_info["filename"],
                                    img_info.get("subfolder", ""),
                                )
                                images.append((img_name, img_data))
                                break  # Only take first image
                            if images:
                                break
                        total_images += 1
                    except Exception as e:
                        log.error("  FAILED: %s seed=%d: %s", prompt_id, seed, e)

                # Upload to S3
                if images:
                    try:
                        upload_to_s3(S3_BUCKET, experiment_id, images, metadata)
                    except Exception as e:
                        log.error("  S3 upload failed for %s: %s", experiment_id, e)

                    # Also save locally
                    local_dir = Path(OUTPUT_DIR) / experiment_id
                    local_dir.mkdir(parents=True, exist_ok=True)
                    for img_name, img_data in images:
                        (local_dir / img_name).write_bytes(img_data)
                    with open(local_dir / "metadata.json", "w") as f:
                        json.dump(metadata, f, ensure_ascii=False, indent=2)

    log.info("=== Done: %d models, %d images ===", total_models, total_images)


def main():
    parser = argparse.ArgumentParser(description="Batch eval image generator")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be generated")
    parser.add_argument("--status", action="store_true", help="Check ComfyUI status")
    parser.add_argument("--models", type=str, help="Comma-separated model names to generate")
    parser.add_argument("--prompts", type=str, help="Comma-separated prompt IDs to generate")
    parser.add_argument("--prompts-file", type=str, default=PROMPTS_FILE)
    parser.add_argument("--no-resume", action="store_true", help="Regenerate all, ignoring existing S3 images")
    parser.add_argument("--rebuild-index", action="store_true", help="Rebuild gallery index.json from S3 metadata")
    args = parser.parse_args()

    if args.status:
        ok = check_status()
        sys.exit(0 if ok else 1)

    if args.rebuild_index:
        rebuild_gallery_index(S3_BUCKET)
        sys.exit(0)

    config = load_prompts(args.prompts_file)
    model_filter = set(args.models.split(",")) if args.models else None
    prompt_filter = set(args.prompts.split(",")) if args.prompts else None

    if not args.dry_run:
        if not check_status():
            log.error("ComfyUI is not reachable. Start it first.")
            sys.exit(1)

    run_generation(config, model_filter, prompt_filter, args.dry_run, resume=not args.no_resume)


if __name__ == "__main__":
    main()
