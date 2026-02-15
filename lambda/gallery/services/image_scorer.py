"""Auto-scoring service using anime-aesthetic ONNX model.

Scores anime/illustration images on a 0-1 scale using skytnt/anime-aesthetic
(ConvNeXtV2-based model trained on anime images).

Model is cached in /tmp after first download from S3 for Lambda warm starts.
"""
import io
import logging
import os
import time

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

MODEL_S3_KEY = "models/scoring/anime_aesthetic.onnx"
MODEL_LOCAL_PATH = "/tmp/anime_aesthetic.onnx"
INPUT_SIZE = 768

# Lazy-loaded globals
_session = None


def _ensure_model(s3_client):
    """Download ONNX model from S3 if not cached in /tmp."""
    global _session
    if _session is not None:
        return _session

    import onnxruntime as ort

    if not os.path.exists(MODEL_LOCAL_PATH):
        logger.info("Downloading scoring model from S3: %s", MODEL_S3_KEY)
        t0 = time.time()
        data = s3_client.get_object(MODEL_S3_KEY)
        with open(MODEL_LOCAL_PATH, "wb") as f:
            f.write(data)
        logger.info("Model downloaded in %.1fs (%d MB)", time.time() - t0, len(data) // 1024 // 1024)

    t0 = time.time()
    _session = ort.InferenceSession(
        MODEL_LOCAL_PATH,
        providers=["CPUExecutionProvider"],
    )
    logger.info("ONNX session loaded in %.1fs", time.time() - t0)
    return _session


def _preprocess(image_bytes, size=INPUT_SIZE):
    """Preprocess image bytes for the model.

    Resizes maintaining aspect ratio, pads to square, normalizes to [-1, 1].
    """
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    w, h = img.size
    r = min(size / w, size / h)
    new_w, new_h = int(w * r), int(h * r)
    img = img.resize((new_w, new_h), Image.LANCZOS)

    padded = Image.new("RGB", (size, size), (0, 0, 0))
    padded.paste(img, ((size - new_w) // 2, (size - new_h) // 2))

    arr = np.array(padded, dtype=np.float32) / 255.0
    arr = (arr - 0.5) / 0.5
    arr = arr.transpose(2, 0, 1)  # HWC -> CHW
    return arr[np.newaxis, ...]  # Add batch dim


def score_image(s3_client, image_bytes):
    """Score a single image.

    Args:
        s3_client: S3Client instance (for model download).
        image_bytes: Raw image bytes (PNG/JPEG/WebP).

    Returns:
        float: Aesthetic score 0.0-1.0 (higher = better).
        Returns None if scoring fails.
    """
    try:
        sess = _ensure_model(s3_client)
        inp = _preprocess(image_bytes)
        score = sess.run(["score"], {"img": inp})[0][0][0]
        return round(float(score), 4)
    except Exception:
        logger.exception("Scoring failed")
        return None


def score_images(s3_client, image_list):
    """Score multiple images.

    Args:
        s3_client: S3Client instance.
        image_list: List of (name, image_bytes) tuples.

    Returns:
        dict: {name: score} mapping.
    """
    results = {}
    for name, image_bytes in image_list:
        score = score_image(s3_client, image_bytes)
        if score is not None:
            results[name] = score
    return results
