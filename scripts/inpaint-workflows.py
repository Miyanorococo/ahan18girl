#!/usr/bin/env python3
"""
Standalone inpainting workflow script for post-selection image fixes.

Provides ComfyUI API workflow builders for common inpainting tasks:
  - face:    Fix face quality/expression via FaceDetailer (auto-detect, no mask)
  - region:  Fix specific regions (underwear/nipple color) via mask-based inpaint
  - hand:    Fix hand anatomy issues via mask-based inpaint
  - upscale: Upscale image 2x via UltimateSDUpscale

Usage:
    python inpaint-workflows.py face    --image input.png --prompt "smiling, happy"
    python inpaint-workflows.py region  --image input.png --mask mask.png --prompt "white lace bra"
    python inpaint-workflows.py hand    --image input.png --mask mask.png
    python inpaint-workflows.py upscale --image input.png --prompt "1girl, detailed"

Environment:
    COMFYUI_URL    ComfyUI API URL (default: http://127.0.0.1:8188)
"""

import argparse
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

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("inpaint-workflows")

COMFYUI_URL = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")


# ---------------------------------------------------------------------------
# ComfyUI API helpers (copied from generate-eval.py for standalone use)
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


def queue_prompt(workflow_json):
    """Queue a prompt and return the prompt_id."""
    resp = comfyui_api("/prompt", method="POST", data={"prompt": workflow_json})
    return resp.get("prompt_id")


def wait_for_completion(prompt_id, timeout=600):
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


def check_status():
    """Check ComfyUI is running and GPU available."""
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


def run_workflow_and_get_image(workflow, step_name, timeout=600):
    """Queue a workflow, wait for completion, and return the output image bytes."""
    try:
        pid = queue_prompt(workflow)
        result = wait_for_completion(pid, timeout=timeout)
        outputs = result.get("outputs", {})
        for node_id in sorted(outputs.keys()):
            for img_info in outputs[node_id].get("images", []):
                img_data = get_image(
                    img_info["filename"],
                    img_info.get("subfolder", ""),
                )
                if img_data:
                    return img_data
    except Exception as e:
        log.error("%s failed: %s", step_name, e)
    return None


# ---------------------------------------------------------------------------
# Workflow builders
# ---------------------------------------------------------------------------

def build_face_inpaint(checkpoint, image_name, expression_prompt, negative,
                       seed, clip_skip=2, denoise=0.4):
    """Fix face quality/expression via FaceDetailer (Impact-Pack).

    Auto-detects faces using face_yolov8m + SAM segmentation.
    No mask image needed.

    Args:
        checkpoint: model checkpoint filename (e.g. "wai-nsfw-illustrious-v16.safetensors")
        image_name: filename in ComfyUI input/ directory
        expression_prompt: prompt describing desired face/expression
        negative: negative prompt
        seed: random seed
        clip_skip: CLIP skip layers (default 2 for Illustrious-based models)
        denoise: inpaint denoise strength (default 0.4)

    Returns:
        ComfyUI API workflow dict
    """
    return {
        "1": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": checkpoint},
        },
        "2": {
            "class_type": "CLIPSetLastLayer",
            "inputs": {"clip": ["1", 1], "stop_at_clip_layer": -clip_skip},
        },
        "3": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": expression_prompt, "clip": ["2", 0]},
        },
        "4": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": negative, "clip": ["2", 0]},
        },
        "10": {
            "class_type": "LoadImage",
            "inputs": {"image": image_name},
        },
        "11": {
            "class_type": "UltralyticsDetectorProvider",
            "inputs": {"model_name": "bbox/face_yolov8m.pt"},
        },
        "12": {
            "class_type": "SAMLoader",
            "inputs": {"model_name": "sam_vit_b_01ec64.pth", "device_mode": "AUTO"},
        },
        "13": {
            "class_type": "FaceDetailer",
            "inputs": {
                "image": ["10", 0],
                "model": ["1", 0],
                "clip": ["2", 0],
                "vae": ["1", 2],
                "positive": ["3", 0],
                "negative": ["4", 0],
                "bbox_detector": ["11", 0],
                "sam_model_opt": ["12", 0],
                "guide_size": 512,
                "guide_size_for": True,
                "max_size": 1024,
                "seed": seed,
                "steps": 20,
                "cfg": 7,
                "sampler_name": "euler_ancestral",
                "scheduler": "sgm_uniform",
                "denoise": denoise,
                "feather": 5,
                "noise_mask": True,
                "force_inpaint": True,
                "bbox_threshold": 0.5,
                "bbox_dilation": 10,
                "bbox_crop_factor": 3.0,
                "sam_detection_hint": "center-1",
                "sam_dilation": 0,
                "sam_threshold": 0.93,
                "sam_bbox_expansion": 0,
                "sam_mask_hint_threshold": 0.7,
                "sam_mask_hint_use_negative": "False",
                "drop_size": 10,
                "wildcard": "",
                "cycle": 1,
                "max_detections": 2,
            },
        },
        "8": {
            "class_type": "SaveImage",
            "inputs": {"images": ["13", 0], "filename_prefix": "inpaint_face"},
        },
    }


def build_region_inpaint(checkpoint, image_name, region_prompt, replace_prompt,
                         negative, seed, clip_skip=2, denoise=0.35,
                         mask_image=None):
    """Fix specific regions via mask-based inpainting.

    Uses a pre-drawn mask image (LoadImage) for region selection.
    GroundingDINO-based auto-detection is not used since it may not be
    installed in all environments.

    Args:
        checkpoint: model checkpoint filename
        image_name: filename in ComfyUI input/ directory
        region_prompt: not used when mask_image is provided (kept for API compat)
        replace_prompt: prompt describing what the region should become
        negative: negative prompt
        seed: random seed
        clip_skip: CLIP skip layers (default 2)
        denoise: inpaint denoise strength (default 0.35)
        mask_image: filename of mask image in ComfyUI input/ (white=inpaint area).
                    Required for this workflow.

    Returns:
        ComfyUI API workflow dict
    """
    if not mask_image:
        raise ValueError("build_region_inpaint requires mask_image (filename in ComfyUI input/)")

    return {
        "1": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": checkpoint},
        },
        "2": {
            "class_type": "CLIPSetLastLayer",
            "inputs": {"clip": ["1", 1], "stop_at_clip_layer": -clip_skip},
        },
        "3": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": replace_prompt, "clip": ["2", 0]},
        },
        "4": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": negative, "clip": ["2", 0]},
        },
        "10": {
            "class_type": "LoadImage",
            "inputs": {"image": image_name},
        },
        "11": {
            "class_type": "LoadImage",
            "inputs": {"image": mask_image},
        },
        "12": {
            "class_type": "VAEEncode",
            "inputs": {
                "pixels": ["10", 0],
                "vae": ["1", 2],
            },
        },
        "13": {
            "class_type": "SetLatentNoiseMask",
            "inputs": {
                "samples": ["12", 0],
                "mask": ["11", 1],  # LoadImage output 1 = mask channel
            },
        },
        "14": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["1", 0],
                "positive": ["3", 0],
                "negative": ["4", 0],
                "latent_image": ["13", 0],
                "seed": seed,
                "steps": 30,
                "cfg": 7,
                "sampler_name": "euler_ancestral",
                "scheduler": "sgm_uniform",
                "denoise": denoise,
            },
        },
        "15": {
            "class_type": "VAEDecode",
            "inputs": {
                "samples": ["14", 0],
                "vae": ["1", 2],
            },
        },
        "8": {
            "class_type": "SaveImage",
            "inputs": {"images": ["15", 0], "filename_prefix": "inpaint_region"},
        },
    }


def build_hand_fix(checkpoint, image_name, negative, seed,
                   clip_skip=2, denoise=0.65, mask_image=None):
    """Fix hand anatomy issues via auto-detection (FaceDetailer with hand model).

    Uses hand_yolov8s detector from Impact-Pack for automatic hand detection.
    Falls back to mask-based inpainting if mask_image is provided.

    Args:
        checkpoint: model checkpoint filename
        image_name: filename in ComfyUI input/ directory
        negative: negative prompt
        seed: random seed
        clip_skip: CLIP skip layers (default 2)
        denoise: inpaint denoise strength (default 0.65, higher for anatomy fixes)
        mask_image: optional mask image. If None, uses auto-detection.

    Returns:
        ComfyUI API workflow dict
    """

    hand_prompt = "detailed hands, five fingers, natural pose, correct anatomy, smooth skin"
    hand_negative = (
        f"extra fingers, mutated hands, deformed fingers, missing fingers, "
        f"fused fingers, too many fingers, bad anatomy, {negative}"
    )

    # Auto-detection mode: use FaceDetailer with hand_yolov8s detector
    # Same pattern as build_face_inpaint but with hand detection model
    if not mask_image:
        return {
            "1": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": checkpoint},
            },
            "2": {
                "class_type": "CLIPSetLastLayer",
                "inputs": {"clip": ["1", 1], "stop_at_clip_layer": -clip_skip},
            },
            "3": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": hand_prompt, "clip": ["2", 0]},
            },
            "4": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": hand_negative, "clip": ["2", 0]},
            },
            "10": {
                "class_type": "LoadImage",
                "inputs": {"image": image_name},
            },
            "11": {
                "class_type": "UltralyticsDetectorProvider",
                "inputs": {"model_name": "bbox/hand_yolov8s.pt"},
            },
            "12": {
                "class_type": "SAMLoader",
                "inputs": {"model_name": "sam_vit_b_01ec64.pth", "device_mode": "AUTO"},
            },
            "13": {
                "class_type": "FaceDetailer",
                "inputs": {
                    "image": ["10", 0],
                    "model": ["1", 0],
                    "clip": ["2", 0],
                    "vae": ["1", 2],
                    "positive": ["3", 0],
                    "negative": ["4", 0],
                    "bbox_detector": ["11", 0],
                    "sam_model_opt": ["12", 0],
                    "guide_size": 512,
                    "guide_size_for": True,
                    "max_size": 1024,
                    "seed": seed,
                    "steps": 25,
                    "cfg": 7,
                    "sampler_name": "euler_ancestral",
                    "scheduler": "sgm_uniform",
                    "denoise": denoise,
                    "feather": 10,
                    "noise_mask": True,
                    "force_inpaint": True,
                    "bbox_threshold": 0.3,
                    "bbox_dilation": 15,
                    "bbox_crop_factor": 3.0,
                    "sam_detection_hint": "center-1",
                    "sam_dilation": 0,
                    "sam_threshold": 0.93,
                    "sam_bbox_expansion": 0,
                    "sam_mask_hint_threshold": 0.7,
                    "sam_mask_hint_use_negative": "False",
                    "drop_size": 10,
                    "wildcard": "",
                    "cycle": 1,
                    "max_detections": 4,
                    "inpaint_model": False,
                    "noise_mask_feather": 20,
                },
            },
            "20": {
                "class_type": "SaveImage",
                "inputs": {
                    "images": ["13", 0],
                    "filename_prefix": "hand_fix",
                },
            },
        }

    # Mask-based fallback (for manual mask)
    return {
        "1": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": checkpoint},
        },
        "2": {
            "class_type": "CLIPSetLastLayer",
            "inputs": {"clip": ["1", 1], "stop_at_clip_layer": -clip_skip},
        },
        "3": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": hand_prompt, "clip": ["2", 0]},
        },
        "4": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": hand_negative, "clip": ["2", 0]},
        },
        "10": {
            "class_type": "LoadImage",
            "inputs": {"image": image_name},
        },
        "11": {
            "class_type": "LoadImage",
            "inputs": {"image": mask_image},
        },
        "12": {
            "class_type": "VAEEncode",
            "inputs": {
                "pixels": ["10", 0],
                "vae": ["1", 2],
            },
        },
        "13": {
            "class_type": "SetLatentNoiseMask",
            "inputs": {
                "samples": ["12", 0],
                "mask": ["11", 1],
            },
        },
        "14": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["1", 0],
                "positive": ["3", 0],
                "negative": ["4", 0],
                "latent_image": ["13", 0],
                "seed": seed,
                "steps": 30,
                "cfg": 7,
                "sampler_name": "euler_ancestral",
                "scheduler": "sgm_uniform",
                "denoise": denoise,
            },
        },
        "15": {
            "class_type": "VAEDecode",
            "inputs": {
                "samples": ["14", 0],
                "vae": ["1", 2],
            },
        },
        "8": {
            "class_type": "SaveImage",
            "inputs": {"images": ["15", 0], "filename_prefix": "inpaint_hand"},
        },
    }


def build_upscale(checkpoint, image_name, positive, negative, seed,
                  clip_skip=2, denoise=0.15, scale=2,
                  upscale_model="4x_foolhardy_Remacri.pth"):
    """Upscale image using UltimateSDUpscale.

    Uses tile-based upscaling with 4x Remacri model, then scales to
    the requested factor. Default 2x takes 1024x1536 -> 2048x3072
    (FANZA recommended resolution).

    Args:
        checkpoint: model checkpoint filename
        image_name: filename in ComfyUI input/ directory
        positive: positive prompt (context for tile generation)
        negative: negative prompt
        seed: random seed
        clip_skip: CLIP skip layers (default 2)
        denoise: tile denoise strength (default 0.15, keep low to preserve detail)
        scale: upscale factor (default 2)
        upscale_model: upscale model filename (default: 4x_foolhardy_Remacri.pth)

    Returns:
        ComfyUI API workflow dict
    """
    return {
        "1": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": checkpoint},
        },
        "2": {
            "class_type": "CLIPSetLastLayer",
            "inputs": {"clip": ["1", 1], "stop_at_clip_layer": -clip_skip},
        },
        "3": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": positive, "clip": ["2", 0]},
        },
        "4": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": negative, "clip": ["2", 0]},
        },
        "10": {
            "class_type": "LoadImage",
            "inputs": {"image": image_name},
        },
        "11": {
            "class_type": "UpscaleModelLoader",
            "inputs": {"model_name": upscale_model},
        },
        "12": {
            "class_type": "UltimateSDUpscale",
            "inputs": {
                "upscale_by": scale,
                "seed": seed,
                "steps": 20,
                "cfg": 7,
                "sampler_name": "euler_ancestral",
                "scheduler": "sgm_uniform",
                "denoise": denoise,
                "mode_type": "Linear",
                "tile_width": 512,
                "tile_height": 768,
                "mask_blur": 8,
                "tile_padding": 32,
                "seam_fix_mode": "Half Tile",
                "seam_fix_denoise": 0.15,
                "seam_fix_width": 64,
                "seam_fix_mask_blur": 8,
                "seam_fix_padding": 16,
                "force_uniform_tiles": True,
                "tiled_decode": False,
                "batch_size": 1,
                "image": ["10", 0],
                "model": ["1", 0],
                "positive": ["3", 0],
                "negative": ["4", 0],
                "vae": ["1", 2],
                "upscale_model": ["11", 0],
            },
        },
        "8": {
            "class_type": "SaveImage",
            "inputs": {"images": ["12", 0], "filename_prefix": "upscale"},
        },
    }


# ---------------------------------------------------------------------------
# CLI runner
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="ComfyUI inpainting workflow runner for post-selection fixes",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Fix face expression
  python inpaint-workflows.py face --image photo.png --prompt "smiling, happy, looking at viewer"

  # Fix underwear color (requires mask)
  python inpaint-workflows.py region --image photo.png --mask underwear_mask.png \\
      --prompt "white lace bra, matching white lace panties"

  # Fix hand anatomy (requires mask)
  python inpaint-workflows.py hand --image photo.png --mask hand_mask.png

  # Upscale 2x
  python inpaint-workflows.py upscale --image photo.png --prompt "1girl, detailed anime"
""",
    )
    parser.add_argument("workflow", choices=["face", "region", "hand", "upscale"],
                        help="Workflow type to run")
    parser.add_argument("--image", required=True,
                        help="Image filename in ComfyUI input/ directory")
    parser.add_argument("--mask",
                        help="Mask filename in ComfyUI input/ (white=inpaint area). "
                             "Required for 'region' and 'hand' workflows.")
    parser.add_argument("--checkpoint", default="wai-nsfw-illustrious-v16.safetensors",
                        help="Model checkpoint filename (default: wai-nsfw-illustrious-v16.safetensors)")
    parser.add_argument("--prompt",
                        help="Prompt for the workflow (expression for face, replacement for region, "
                             "context for upscale)")
    parser.add_argument("--negative", default="bad quality, worst quality",
                        help="Negative prompt (default: 'bad quality, worst quality')")
    parser.add_argument("--seed", type=int, default=42,
                        help="Random seed (default: 42)")
    parser.add_argument("--clip-skip", type=int, default=2,
                        help="CLIP skip layers (default: 2)")
    parser.add_argument("--denoise", type=float,
                        help="Override denoise strength (default varies by workflow)")
    parser.add_argument("--scale", type=int, default=2,
                        help="Upscale factor for 'upscale' workflow (default: 2)")
    parser.add_argument("--output",
                        help="Output filename (default: {workflow}_{image})")
    parser.add_argument("--timeout", type=int, default=600,
                        help="Timeout in seconds for workflow completion (default: 600)")
    parser.add_argument("--json-only", action="store_true",
                        help="Print the workflow JSON and exit without running")
    args = parser.parse_args()

    # Validate mask requirement
    if args.workflow in ("region", "hand") and not args.mask:
        parser.error(f"--mask is required for '{args.workflow}' workflow")

    # Build the workflow
    if args.workflow == "face":
        prompt = args.prompt or "beautiful detailed face, detailed eyes, natural expression"
        denoise = args.denoise if args.denoise is not None else 0.4
        workflow = build_face_inpaint(
            checkpoint=args.checkpoint,
            image_name=args.image,
            expression_prompt=prompt,
            negative=args.negative,
            seed=args.seed,
            clip_skip=args.clip_skip,
            denoise=denoise,
        )

    elif args.workflow == "region":
        prompt = args.prompt or "white lace bra, matching white lace panties, detailed fabric"
        denoise = args.denoise if args.denoise is not None else 0.35
        workflow = build_region_inpaint(
            checkpoint=args.checkpoint,
            image_name=args.image,
            region_prompt="",
            replace_prompt=prompt,
            negative=args.negative,
            seed=args.seed,
            clip_skip=args.clip_skip,
            denoise=denoise,
            mask_image=args.mask,
        )

    elif args.workflow == "hand":
        denoise = args.denoise if args.denoise is not None else 0.65
        workflow = build_hand_fix(
            checkpoint=args.checkpoint,
            image_name=args.image,
            negative=args.negative,
            seed=args.seed,
            clip_skip=args.clip_skip,
            denoise=denoise,
            mask_image=args.mask,
        )

    elif args.workflow == "upscale":
        prompt = args.prompt or "masterpiece, best quality, detailed"
        denoise = args.denoise if args.denoise is not None else 0.15
        workflow = build_upscale(
            checkpoint=args.checkpoint,
            image_name=args.image,
            positive=prompt,
            negative=args.negative,
            seed=args.seed,
            clip_skip=args.clip_skip,
            denoise=denoise,
            scale=args.scale,
        )

    # JSON-only mode: print and exit
    if args.json_only:
        print(json.dumps(workflow, indent=2))
        sys.exit(0)

    # Check ComfyUI connectivity
    if not check_status():
        log.error("ComfyUI is not reachable. Start ComfyUI first.")
        sys.exit(1)

    # Run the workflow
    log.info("Running %s workflow on %s (denoise=%.2f, seed=%d)...",
             args.workflow, args.image, denoise, args.seed)

    img_data = run_workflow_and_get_image(workflow, args.workflow, timeout=args.timeout)

    if not img_data:
        log.error("Workflow failed, no output generated")
        sys.exit(1)

    # Save output
    if args.output:
        output_path = Path(args.output)
    else:
        stem = Path(args.image).stem
        output_path = Path(f"{args.workflow}_{stem}.png")

    output_path.write_bytes(img_data)
    log.info("Output saved: %s (%d bytes)", output_path, len(img_data))

    # Also save to ComfyUI input/ for chaining workflows
    for base in ["/opt/ComfyUI/input", "/data/ComfyUI/input"]:
        input_dir = Path(base)
        if input_dir.exists():
            chain_path = input_dir / output_path.name
            chain_path.write_bytes(img_data)
            log.info("Also saved to ComfyUI input/ for chaining: %s", chain_path)
            break


if __name__ == "__main__":
    main()
