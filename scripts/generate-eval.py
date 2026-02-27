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
    """Check ComfyUI is running, GPU available, and KSampler node loaded."""
    try:
        stats = comfyui_api("/system_stats")
        devices = stats.get("devices", [])
        for d in devices:
            name = d.get("name", "unknown")
            vram_total = d.get("vram_total", 0) / (1024**3)
            vram_free = d.get("vram_free", 0) / (1024**3)
            log.info("GPU: %s  VRAM: %.1fGB / %.1fGB", name, vram_total - vram_free, vram_total)
        # Verify KSampler node is available (custom nodes fully initialized)
        try:
            node_info = comfyui_api("/object_info/KSampler")
            if "KSampler" not in node_info:
                log.warning("KSampler node not found in object_info - custom nodes may not be loaded")
        except Exception:
            log.warning("Could not verify KSampler availability")
        return True
    except Exception as e:
        log.error("ComfyUI not reachable: %s", e)
        return False


def queue_prompt(workflow_json):
    """Queue a prompt and return the prompt_id."""
    resp = comfyui_api("/prompt", method="POST", data={"prompt": workflow_json})
    return resp.get("prompt_id")


def clear_queue():
    """Clear ComfyUI queue to prevent stale prompts from blocking."""
    try:
        comfyui_api("/queue", method="POST", data={"clear": True})
    except Exception:
        pass


def warmup_model(checkpoint):
    """Send a tiny 64x64 1-step prompt to force SDXL model loading into VRAM.

    ComfyUI起動直後の初回プロンプトではモデルロードが発生し300-500秒かかる。
    本番生成前にダミープロンプトでモデルをVRAMにキャッシュしておくことで、
    初回タイムアウトを防止する。
    """
    log.info("Warming up model: %s (64x64, 1-step dummy prompt)...", checkpoint)
    workflow = build_txt2img_workflow(
        checkpoint=checkpoint,
        positive="test",
        negative="",
        seed=0,
        width=64,
        height=64,
        steps=1,
        cfg=1,
        sampler="euler",
        scheduler="normal",
        clip_skip=1,
    )
    try:
        pid = queue_prompt(workflow)
        wait_for_completion(pid, timeout=900)
        log.info("Warmup complete: model loaded into VRAM")
    except Exception as e:
        log.warning("Warmup failed (generation may still work): %s", e)


def wait_for_completion(prompt_id, timeout=600):
    """Poll history until the prompt completes. Clears queue on timeout."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            history = comfyui_api(f"/history/{prompt_id}")
            if prompt_id in history:
                return history[prompt_id]
        except Exception:
            pass
        time.sleep(2)
    # Clear queue to prevent stale prompts from blocking subsequent requests
    log.warning("Timeout: clearing ComfyUI queue")
    clear_queue()
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

    # Model-group-specific tag filtering
    strip_tags = group.get("strip_tags", [])
    if strip_tags:
        tags = [t.strip() for t in positive.split(",") if t.strip()]
        tags = [t for t in tags if t not in strip_tags]
        positive = ", ".join(tags)

    # Assemble negative: type-specific prefix + group negative
    neg_common = config.get("negative_common", {})
    neg_prefix = neg_common.get(prompt_type, "")
    negative = neg_prefix + group["negative"]

    return positive.strip(", "), negative.strip(", ")


# ---------------------------------------------------------------------------
# S3 upload
# ---------------------------------------------------------------------------

def _make_thumbnail(img_data, max_width=300):
    """Resize image to thumbnail. Returns WebP bytes, or original if Pillow unavailable."""
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(img_data))
        ratio = max_width / img.width
        new_size = (max_width, int(img.height * ratio))
        img = img.resize(new_size, Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="WEBP", quality=80)
        return buf.getvalue()
    except ImportError:
        log.warning("Pillow not available, uploading full-size thumbnail")
        return img_data
    except Exception as e:
        log.warning("Thumbnail generation failed: %s", e)
        return img_data


def _upload_metadata(bucket, experiment_id, metadata):
    """Upload experiment metadata to S3."""
    if not boto3:
        return
    s3 = boto3.client("s3")
    meta_key = f"{GALLERY_PREFIX}/{experiment_id}/metadata.json"
    s3.put_object(
        Bucket=bucket,
        Key=meta_key,
        Body=json.dumps(metadata, ensure_ascii=False, indent=2).encode(),
        ContentType="application/json",
    )


def _upload_single_image(bucket, experiment_id, img_name, img_data):
    """Upload a single image + thumbnail to S3 immediately."""
    if not boto3:
        return
    s3 = boto3.client("s3")
    base = f"{GALLERY_PREFIX}/{experiment_id}"

    # Full-size image
    full_key = f"{base}/full/{img_name}"
    s3.put_object(Bucket=bucket, Key=full_key, Body=img_data, ContentType="image/png")

    # Thumbnail (300px WebP)
    thumb_name = img_name.rsplit(".", 1)[0] + ".webp"
    thumb_key = f"{base}/thumb/{thumb_name}"
    thumb_data = _make_thumbnail(img_data)
    s3.put_object(
        Bucket=bucket, Key=thumb_key, Body=thumb_data,
        ContentType="image/webp" if thumb_data != img_data else "image/png",
    )


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

    # Upload images to full/ and create resized thumbnails in thumb/
    for img_name, img_data in images:
        full_key = f"{base}/full/{img_name}"
        s3.put_object(
            Bucket=bucket, Key=full_key, Body=img_data, ContentType="image/png"
        )

        # Generate thumbnail (300px wide WebP)
        thumb_name = img_name.rsplit(".", 1)[0] + ".webp"
        thumb_key = f"{base}/thumb/{thumb_name}"
        thumb_data = _make_thumbnail(img_data)
        s3.put_object(
            Bucket=bucket, Key=thumb_key, Body=thumb_data,
            ContentType="image/webp" if thumb_data != img_data else "image/png"
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

            prompt_id = exp_id.split("/")[-1] if "/" in exp_id else ""

            entry = {
                "id": exp_id,
                "model": meta.get("model", {}).get("checkpoint", "unknown"),
                "pipeline": meta.get("pipeline", "txt2img"),
                "prompt_summary": meta.get("prompt_summary", ""),
                "genre": meta.get("genre", ""),
                "genre_ja": meta.get("genre_ja", ""),
                "content_type": meta.get("type", ""),
                "nsfw_level": meta.get("nsfw_level", ""),
                "prompt_id": prompt_id,
                "date": meta.get("date", "") or (meta.get("generated_at", "")[:10] if meta.get("generated_at") else ""),
                "image_count": image_count,
                "aesthetic_avg": meta.get("aesthetic_avg"),
                "thumbnail": thumbnail,
                "created_at": meta.get("created_at", "") or meta.get("generated_at", ""),
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

    # Warmup: 最初のモデルのチェックポイントでVRAMにロードしておく
    if not dry_run:
        first_checkpoint = None
        for group in config["model_groups"].values():
            for model_name in group["models"]:
                if model_filter and model_name not in model_filter:
                    continue
                first_checkpoint = CHECKPOINT_MAP.get(model_name)
                if first_checkpoint:
                    break
            if first_checkpoint:
                break
        if first_checkpoint:
            warmup_model(first_checkpoint)

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

                # Generate all seeds for this prompt, then upload as a batch
                local_dir = Path(OUTPUT_DIR) / experiment_id
                local_dir.mkdir(parents=True, exist_ok=True)
                images = []  # [(img_name, img_data), ...]

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
                        img_data = None
                        outputs = result.get("outputs", {})
                        for node_id, node_output in outputs.items():
                            for img_info in node_output.get("images", []):
                                img_data = get_image(
                                    img_info["filename"],
                                    img_info.get("subfolder", ""),
                                )
                                break
                            if img_data:
                                break

                        if img_data:
                            # Save locally immediately (survives ComfyUI crash)
                            (local_dir / img_name).write_bytes(img_data)
                            images.append((img_name, img_data))
                            total_images += 1

                    except Exception as e:
                        log.error("  FAILED: %s seed=%d: %s", prompt_id, seed, e)

                # Upload complete prompt set to S3 (metadata + all images as batch)
                if images:
                    try:
                        upload_to_s3(S3_BUCKET, experiment_id, images, metadata)
                    except Exception as e:
                        log.error("  S3 upload failed for %s: %s", experiment_id, e)
                    with open(local_dir / "metadata.json", "w") as f:
                        json.dump(metadata, f, ensure_ascii=False, indent=2)

    log.info("=== Done: %d models, %d images ===", total_models, total_images)

    # Auto-score and rebuild gallery index after generation
    if total_images > 0 and not dry_run:
        log.info("Auto-scoring all experiments and rebuilding index...")
        try:
            score_all_experiments(S3_BUCKET)
        except Exception as e:
            log.error("Auto-scoring/index rebuild failed: %s", e)
            # Fallback: at least rebuild index without scores
            try:
                rebuild_gallery_index(S3_BUCKET)
            except Exception:
                pass


def score_all_experiments(bucket, force=False):
    """Score all unscored experiments using anime-aesthetic ONNX model.

    Downloads thumbnails from S3, scores them locally, updates metadata.json.
    """
    import onnxruntime as ort
    from concurrent.futures import ThreadPoolExecutor
    from PIL import Image as PILImage
    import io
    import numpy as np

    MODEL_URL = "https://huggingface.co/skytnt/anime-aesthetic/resolve/main/model.onnx"
    MODEL_PATH = "/tmp/anime_aesthetic.onnx"
    INPUT_SIZE = 768

    s3 = boto3.client("s3")
    prefix = f"{GALLERY_PREFIX}/"

    # Download ONNX model if needed
    if not os.path.exists(MODEL_PATH):
        log.info("Downloading scoring model...")
        import urllib.request
        urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
        log.info("Model downloaded: %s", MODEL_PATH)

    sess = ort.InferenceSession(MODEL_PATH, providers=["CPUExecutionProvider"])
    log.info("ONNX session loaded")

    def preprocess(image_bytes):
        img = PILImage.open(io.BytesIO(image_bytes)).convert("RGB")
        w, h = img.size
        r = min(INPUT_SIZE / w, INPUT_SIZE / h)
        new_w, new_h = int(w * r), int(h * r)
        img = img.resize((new_w, new_h), PILImage.LANCZOS)
        padded = PILImage.new("RGB", (INPUT_SIZE, INPUT_SIZE), (0, 0, 0))
        padded.paste(img, ((INPUT_SIZE - new_w) // 2, (INPUT_SIZE - new_h) // 2))
        arr = np.array(padded, dtype=np.float32) / 255.0
        arr = (arr - 0.5) / 0.5
        return arr.transpose(2, 0, 1)[np.newaxis, ...]

    # Scan all metadata.json
    paginator = s3.get_paginator("list_objects_v2")
    experiments = []
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.endswith("/metadata.json"):
                exp_id = key[len(prefix):-len("/metadata.json")]
                experiments.append((exp_id, key))

    log.info("Found %d experiments", len(experiments))

    scored = 0
    skipped = 0
    errors = 0
    import threading
    lock = threading.Lock()
    s3_local = threading.local()

    def get_s3():
        if not hasattr(s3_local, "client"):
            s3_local.client = boto3.client("s3")
        return s3_local.client

    def process_one(exp_id, meta_key):
        nonlocal scored, skipped, errors
        c = get_s3()
        try:
            meta = json.loads(c.get_object(Bucket=bucket, Key=meta_key)["Body"].read())
        except Exception:
            with lock:
                errors += 1
            return

        if not force and meta.get("aesthetic_avg") is not None:
            with lock:
                skipped += 1
            return

        # List images (prefer full/ over thumb/)
        full_prefix = f"{prefix}{exp_id}/full/"
        full_resp = c.list_objects_v2(Bucket=bucket, Prefix=full_prefix, MaxKeys=20)
        image_keys = [o["Key"] for o in full_resp.get("Contents", [])
                      if o["Key"].lower().endswith((".png", ".jpg", ".jpeg", ".webp"))]
        if not image_keys:
            thumb_prefix = f"{prefix}{exp_id}/thumb/"
            thumb_resp = c.list_objects_v2(Bucket=bucket, Prefix=thumb_prefix, MaxKeys=20)
            image_keys = [o["Key"] for o in thumb_resp.get("Contents", [])
                          if o["Key"].lower().endswith((".png", ".jpg", ".jpeg", ".webp"))]
        if not image_keys:
            with lock:
                skipped += 1
            return

        # Download images in parallel (S3 is the bottleneck)
        img_data_map = {}
        def dl(key):
            try:
                data = get_s3().get_object(Bucket=bucket, Key=key)["Body"].read()
                img_data_map[key] = data
            except Exception:
                pass

        with ThreadPoolExecutor(max_workers=5) as dl_pool:
            dl_pool.map(dl, image_keys)

        # Score sequentially (ONNX session is not thread-safe)
        scores = {}
        for img_key, img_data in img_data_map.items():
            try:
                inp = preprocess(img_data)
                with lock:
                    score = float(sess.run(["score"], {"img": inp})[0][0][0])
                name = img_key.rsplit("/", 1)[-1]
                scores[name] = round(score, 4)
            except Exception:
                pass

        if scores:
            avg = round(sum(scores.values()) / len(scores), 4)
            meta["aesthetic_scores"] = scores
            meta["aesthetic_avg"] = avg
            c.put_object(
                Bucket=bucket, Key=meta_key,
                Body=json.dumps(meta, ensure_ascii=False, indent=2).encode(),
                ContentType="application/json",
            )
            with lock:
                scored += 1
                if scored % 50 == 0 or scored <= 3:
                    log.info("  [%d/%d] %s avg=%.3f", scored, len(experiments), exp_id[:50], avg)

    # Process experiments with parallel S3 I/O, sequential ONNX inference
    WORKERS = 8
    log.info("Scoring with %d parallel workers...", WORKERS)
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(process_one, exp_id, meta_key) for exp_id, meta_key in experiments]
        for f in futures:
            f.result()  # propagate exceptions

    log.info("Scoring complete: %d scored, %d skipped (already scored), %d errors", scored, skipped, errors)

    # Rebuild index
    log.info("Rebuilding index...")
    rebuild_gallery_index(bucket)


def build_ipadapter_workflow(checkpoint, positive, negative, seed, width, height,
                              steps, cfg, sampler, scheduler, clip_skip,
                              ref_image, ipa_weight, ipa_model="ip-adapter-plus_sdxl_vit-h.safetensors",
                              clip_vision="CLIP-ViT-bigG-14-laion2B-39B-b160k.safetensors"):
    """Build IP-Adapter workflow (txt2img + reference image for character consistency)."""
    wf = build_txt2img_workflow(checkpoint, positive, negative, seed, width, height,
                                 steps, cfg, sampler, scheduler, clip_skip)
    # Add IP-Adapter nodes
    wf["20"] = {"class_type": "IPAdapterModelLoader", "inputs": {"ipadapter_file": ipa_model}}
    wf["21"] = {"class_type": "CLIPVisionLoader", "inputs": {"clip_name": clip_vision}}
    wf["22"] = {"class_type": "LoadImage", "inputs": {"image": ref_image}}
    wf["23"] = {"class_type": "IPAdapterAdvanced", "inputs": {
        "model": ["1", 0], "ipadapter": ["20", 0], "image": ["22", 0],
        "clip_vision": ["21", 0], "weight": ipa_weight, "weight_type": "linear",
        "combine_embeds": "concat", "start_at": 0.0, "end_at": 1.0, "embeds_scaling": "V only"}}
    # Redirect KSampler model input to IP-Adapter output
    wf["6"]["inputs"]["model"] = ["23", 0]
    return wf


def build_controlnet_workflow(checkpoint, positive, negative, seed, width, height,
                               steps, cfg, sampler, scheduler, clip_skip,
                               control_image, cn_model, strength=0.6):
    """Build ControlNet workflow (txt2img + control signal)."""
    wf = build_txt2img_workflow(checkpoint, positive, negative, seed, width, height,
                                 steps, cfg, sampler, scheduler, clip_skip)
    wf["20"] = {"class_type": "ControlNetLoader", "inputs": {"control_net_name": cn_model}}
    wf["21"] = {"class_type": "LoadImage", "inputs": {"image": control_image}}
    wf["22"] = {"class_type": "ControlNetApplyAdvanced", "inputs": {
        "positive": ["3", 0], "negative": ["4", 0], "control_net": ["20", 0],
        "image": ["21", 0], "strength": strength, "start_percent": 0.0, "end_percent": 1.0}}
    wf["6"]["inputs"]["positive"] = ["22", 0]
    wf["6"]["inputs"]["negative"] = ["22", 1]
    return wf


def run_layer2_tests(checkpoint="wai-nsfw-illustrious-v16.safetensors"):
    """Run Layer 2 control technology tests using proven generate-eval API."""
    import shutil

    log.info("=== Layer 2 Batch Test (via generate-eval.py) ===")
    warmup_model(checkpoint)
    s3 = boto3.client("s3")
    S3_PREFIX = "experiments/layer2-batch"
    seeds = [42, 123, 456]
    generated = 0
    failed = 0
    clip_skip = 2
    W, H = 1024, 1536

    def run_one(wf, prefix, timeout=900):
        nonlocal generated, failed
        try:
            pid = queue_prompt(wf)
            result = wait_for_completion(pid, timeout=timeout)
            outputs = result.get("outputs", {})
            for nid in ["8", "7"]:
                for img in outputs.get(nid, {}).get("images", []):
                    img_data = get_image(img["filename"], img.get("subfolder", ""))
                    if img_data:
                        # Save locally and upload to S3
                        local = f"{OUTPUT_DIR}/{prefix}.png"
                        os.makedirs(os.path.dirname(local), exist_ok=True)
                        with open(local, "wb") as f:
                            f.write(img_data)
                        s3.put_object(Bucket=S3_BUCKET, Key=f"{S3_PREFIX}/{prefix}.png",
                                     Body=img_data, ContentType="image/png")
                        generated += 1
                        log.info("  OK: %s", prefix)
                        return local
        except Exception as e:
            log.error("  FAIL: %s - %s", prefix, e)
        failed += 1
        return None

    # === Reference images ===
    log.info("--- Reference Images ---")
    ref_prompts = [
        ("1girl, solo, standing, school uniform, full body, white background, smile, brown hair, long hair", "ref_stand"),
        ("1girl, solo, sitting on chair, school uniform, classroom, looking at viewer, brown hair", "ref_sit"),
        ("nsfw, explicit, 1girl, solo, lying on bed, nude, from above, bedroom, blush, brown hair, large breasts", "ref_nsfw"),
    ]
    for prompt, name in ref_prompts:
        pos = f"masterpiece, best quality, {prompt}"
        neg = "bad quality, worst quality, bad anatomy, bad hands"
        wf = build_txt2img_workflow(checkpoint, pos, neg, 42, W, H, 25, 7, "euler_ancestral", "sgm_uniform", clip_skip)
        local = run_one(wf, f"L2B_{name}")
        if local:
            os.makedirs("/data/ComfyUI/input", exist_ok=True)
            shutil.copy2(local, f"/data/ComfyUI/input/{name}.png")

    # === IP-Adapter: 5 weights × 3 scenes × 3 seeds ===
    log.info("--- #10 IP-Adapter ---")
    ipa_scenes = [
        ("1girl, running, park, cherry blossom, school uniform, wind, brown hair", "run"),
        ("1girl, swimming pool, swimsuit, summer, blue sky, brown hair", "pool"),
        ("nsfw, 1girl, onsen, nude, hot spring, steam, brown hair", "onsen"),
    ]
    for weight in [0.2, 0.3, 0.4, 0.5, 0.7]:
        for prompt, scene in ipa_scenes:
            for seed in seeds:
                pos = f"masterpiece, best quality, {prompt}"
                neg = "bad quality, worst quality"
                wf = build_ipadapter_workflow(checkpoint, pos, neg, seed, W, H,
                    25, 7, "euler_ancestral", "sgm_uniform", clip_skip,
                    "ref_stand.png", weight)
                run_one(wf, f"L2B_ipa_w{str(weight).replace('.','')}__{scene}_s{seed}")

    # === ControlNet Union: 3 strengths × 3 scenes ===
    log.info("--- #28 ControlNet Union ---")
    for strength in [0.3, 0.5, 0.8]:
        for prompt, name in [
            ("1girl, bikini, beach, sunset, brown hair", "beach"),
            ("1girl, kimono, shrine, autumn, brown hair", "shrine"),
            ("nsfw, 1girl, nude, bathroom, steam, brown hair", "bath"),
        ]:
            pos = f"masterpiece, best quality, {prompt}"
            neg = "bad quality, worst quality"
            wf = build_controlnet_workflow(checkpoint, pos, neg, 42, W, H,
                25, 7, "euler_ancestral", "sgm_uniform", clip_skip,
                "ref_stand.png", "controlnet-union-sdxl.safetensors", strength)
            run_one(wf, f"L2B_cn_s{str(strength).replace('.','')}__{name}")

    # === DWPose: 3 transfers × 3 seeds ===
    log.info("--- #8 DWPose ---")
    # Extract pose
    pose_wf = {
        "10": {"class_type": "LoadImage", "inputs": {"image": "ref_stand.png"}},
        "11": {"class_type": "DWPreprocessor", "inputs": {
            "image": ["10", 0], "detect_hand": "enable", "detect_body": "enable",
            "detect_face": "enable", "resolution": 1024}},
        "8": {"class_type": "SaveImage", "inputs": {"images": ["11", 0], "filename_prefix": "L2B_pose"}},
    }
    pose_local = run_one(pose_wf, "L2B_pose_extract")
    if pose_local:
        shutil.copy2(pose_local, "/data/ComfyUI/input/pose_ref.png")
        for prompt, name in [
            ("1girl, bikini, beach, sunset, brown hair", "beach"),
            ("1girl, kimono, tea ceremony, tatami, brown hair", "kimono"),
        ]:
            for seed in seeds:
                pos = f"masterpiece, best quality, {prompt}"
                neg = "bad quality, worst quality"
                wf = build_controlnet_workflow(checkpoint, pos, neg, seed, W, H,
                    25, 7, "euler_ancestral", "sgm_uniform", clip_skip,
                    "pose_ref.png", "control-lora-openposeXL2-rank256.safetensors", 0.7)
                run_one(wf, f"L2B_dwpose_{name}_s{seed}")

    # === Depth: 3 transfers × 3 seeds ===
    log.info("--- #9 Depth ---")
    depth_wf = {
        "10": {"class_type": "LoadImage", "inputs": {"image": "ref_stand.png"}},
        "11": {"class_type": "DepthAnythingPreprocessor", "inputs": {
            "image": ["10", 0], "ckpt_name": "depth_anything_vitl14.pth", "resolution": 1024}},
        "8": {"class_type": "SaveImage", "inputs": {"images": ["11", 0], "filename_prefix": "L2B_depth"}},
    }
    depth_local = run_one(depth_wf, "L2B_depth_extract")
    if depth_local:
        shutil.copy2(depth_local, "/data/ComfyUI/input/depth_ref.png")
        for prompt, name in [
            ("1girl, maid outfit, elegant room, chandelier, brown hair", "maid"),
            ("1girl, nurse uniform, hospital corridor, brown hair", "nurse"),
        ]:
            for seed in seeds:
                pos = f"masterpiece, best quality, {prompt}"
                neg = "bad quality, worst quality"
                wf = build_controlnet_workflow(checkpoint, pos, neg, seed, W, H,
                    25, 7, "euler_ancestral", "sgm_uniform", clip_skip,
                    "depth_ref.png", "controlnet-union-sdxl.safetensors", 0.5)
                run_one(wf, f"L2B_depth_{name}_s{seed}")

    # === #12 ADetailer: 5 face corrections ===
    log.info("--- #12 ADetailer ---")
    face_prompts = [
        ("1girl, close up face, smile, brown hair, school uniform", 100),
        ("1girl, full body, standing, looking away, brown hair, casual", 200),
        ("1girl, upper body, winking, peace sign, brown hair, cafe", 300),
        ("nsfw, 1girl, close up face, ahegao, blush, brown hair", 400),
        ("1girl, side view, profile, brown hair, sunset background", 500),
    ]
    for prompt, seed in face_prompts:
        # Generate base image
        pos = f"masterpiece, best quality, {prompt}"
        neg = "bad quality, worst quality, bad anatomy"
        base_wf = build_txt2img_workflow(checkpoint, pos, neg, seed, W, H,
            25, 7, "euler_ancestral", "sgm_uniform", clip_skip)
        base_local = run_one(base_wf, f"L2B_ad_base_s{seed}")
        if base_local:
            shutil.copy2(base_local, f"/data/ComfyUI/input/ad_input_{seed}.png")
            # Apply FaceDetailer
            ad_wf = {
                "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}},
                "2": {"class_type": "CLIPSetLastLayer", "inputs": {"clip": ["1", 1], "stop_at_clip_layer": -clip_skip}},
                "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "masterpiece, best quality, beautiful detailed face, detailed eyes", "clip": ["2", 0]}},
                "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "bad quality, worst quality", "clip": ["2", 0]}},
                "10": {"class_type": "LoadImage", "inputs": {"image": f"ad_input_{seed}.png"}},
                "11": {"class_type": "UltralyticsDetectorProvider", "inputs": {"model_name": "bbox/face_yolov8m.pt"}},
                "12": {"class_type": "SAMLoader", "inputs": {"model_name": "sam_vit_b_01ec64.pth", "device_mode": "AUTO"}},
                "13": {"class_type": "FaceDetailer", "inputs": {
                    "image": ["10", 0], "model": ["1", 0], "clip": ["2", 0], "vae": ["1", 2],
                    "positive": ["3", 0], "negative": ["4", 0],
                    "bbox_detector": ["11", 0], "sam_model_opt": ["12", 0],
                    "guide_size": 512, "guide_size_for": True, "max_size": 1024,
                    "seed": seed, "steps": 20, "cfg": 7,
                    "sampler_name": "euler_ancestral", "scheduler": "sgm_uniform",
                    "denoise": 0.4, "feather": 5, "noise_mask": True,
                    "force_inpaint": True, "bbox_threshold": 0.5,
                    "bbox_dilation": 10, "bbox_crop_factor": 3.0,
                    "sam_detection_hint": "center-1", "sam_dilation": 0,
                    "sam_threshold": 0.93, "sam_bbox_expansion": 0,
                    "sam_mask_hint_threshold": 0.7, "sam_mask_hint_use_negative": "False",
                    "drop_size": 10, "wildcard": "", "cycle": 1}},
                "8": {"class_type": "SaveImage", "inputs": {"images": ["13", 0], "filename_prefix": f"L2B_adetailer_s{seed}"}},
            }
            run_one(ad_wf, f"L2B_adetailer_s{seed}")

    # === #13 Upscale: 3 refs × 2 denoise ===
    log.info("--- #13 Upscale ---")
    for ref_name in ["ref_stand", "ref_sit", "ref_nsfw"]:
        for denoise in [0.15, 0.3]:
            prefix = f"L2B_upscale_{ref_name}_d{str(denoise).replace('.','')}"
            up_wf = {
                "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}},
                "2": {"class_type": "CLIPSetLastLayer", "inputs": {"clip": ["1", 1], "stop_at_clip_layer": -clip_skip}},
                "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "masterpiece, best quality, highly detailed", "clip": ["2", 0]}},
                "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "bad quality, worst quality", "clip": ["2", 0]}},
                "10": {"class_type": "LoadImage", "inputs": {"image": f"{ref_name}.png"}},
                "11": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": "4x_foolhardy_Remacri.pth"}},
                "12": {"class_type": "UltimateSDUpscale", "inputs": {
                    "upscale_by": 2.0, "seed": 42, "steps": 15, "cfg": 7,
                    "sampler_name": "euler_ancestral", "scheduler": "sgm_uniform",
                    "denoise": denoise, "mode_type": "Linear",
                    "tile_width": 512, "tile_height": 512,
                    "mask_blur": 8, "tile_padding": 32,
                    "seam_fix_mode": "None", "seam_fix_denoise": 1.0,
                    "seam_fix_width": 64, "seam_fix_mask_blur": 8, "seam_fix_padding": 16,
                    "force_uniform_tiles": True, "tiled_decode": False, "batch_size": 1,
                    "image": ["10", 0], "model": ["1", 0], "positive": ["3", 0],
                    "negative": ["4", 0], "vae": ["1", 2], "upscale_model": ["11", 0]}},
                "8": {"class_type": "SaveImage", "inputs": {"images": ["12", 0], "filename_prefix": prefix}},
            }
            run_one(up_wf, prefix)

    log.info("=== Layer 2 COMPLETE: %d generated, %d failed ===", generated, failed)
    # Upload summary
    summary = f"COMPLETE: {generated} generated, {failed} failed"
    s3.put_object(Bucket=S3_BUCKET, Key=f"{S3_PREFIX}/status.txt",
                  Body=summary.encode(), ContentType="text/plain")


def main():
    parser = argparse.ArgumentParser(description="Batch eval image generator")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be generated")
    parser.add_argument("--status", action="store_true", help="Check ComfyUI status")
    parser.add_argument("--models", type=str, help="Comma-separated model names to generate")
    parser.add_argument("--prompts", type=str, help="Comma-separated prompt IDs to generate")
    parser.add_argument("--prompts-file", type=str, default=PROMPTS_FILE)
    parser.add_argument("--no-resume", action="store_true", help="Regenerate all, ignoring existing S3 images")
    parser.add_argument("--rebuild-index", action="store_true", help="Rebuild gallery index.json from S3 metadata")
    parser.add_argument("--score-all", action="store_true", help="Score all unscored experiments with anime-aesthetic ONNX")
    parser.add_argument("--force-score", action="store_true", help="Re-score all experiments (even already scored)")
    parser.add_argument("--layer2-test", action="store_true", help="Run Layer 2 control technology batch tests")
    args = parser.parse_args()

    if args.status:
        ok = check_status()
        sys.exit(0 if ok else 1)

    if args.score_all:
        score_all_experiments(S3_BUCKET, force=args.force_score)
        sys.exit(0)

    if args.rebuild_index:
        rebuild_gallery_index(S3_BUCKET)
        sys.exit(0)

    if args.layer2_test:
        if not check_status():
            log.error("ComfyUI not reachable.")
            sys.exit(1)
        run_layer2_tests()
        sys.exit(0)

    config = load_prompts(args.prompts_file)
    model_filter = set(args.models.split(",")) if args.models else None
    prompt_filter = set(args.prompts.split(",")) if args.prompts else None

    # Validate: all prompt ids must start with _meta.book_id + "_"
    book_id = config.get("_meta", {}).get("book_id", "")
    if book_id:
        bad = []
        for p in config.get("prompts", []):
            pid = p.get("id", "")
            if not pid.startswith(book_id + "_"):
                bad.append(pid)
        if bad:
            log.error(
                "PROMPT ID MISMATCH: _meta.book_id is '%s' but %d prompt(s) have wrong prefix.\n"
                "  Mismatched IDs: %s\n"
                "  Every prompt 'id' must start with '%s_' (e.g. '%s_S01_scene_name').\n"
                "  Fix: change the 'id' field of the listed prompts to start with '%s_'.",
                book_id, len(bad), bad, book_id, book_id, book_id,
            )
            sys.exit(1)

    if not args.dry_run:
        if not check_status():
            log.error("ComfyUI is not reachable. Start it first.")
            sys.exit(1)

    run_generation(config, model_filter, prompt_filter, args.dry_run, resume=not args.no_resume)


if __name__ == "__main__":
    main()
