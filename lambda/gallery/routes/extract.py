import json
import logging
import os
import tempfile
import urllib.parse
import zipfile
from pathlib import Path

from services.s3_client import S3Client
from services.index_builder import update_index
from services.thumbnail import generate_thumbnail

logger = logging.getLogger(__name__)

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}


def handle_s3_event(event):
    """Handle S3 PutObject event for zip extraction."""
    s3 = S3Client()

    for record in event.get("Records", []):
        bucket = record["s3"]["bucket"]["name"]
        key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])

        if not key.endswith(".zip"):
            logger.info("Skipping non-zip file: %s", key)
            continue

        logger.info("Processing zip: %s", key)
        _process_zip(s3, key)

    return {"statusCode": 200, "body": json.dumps({"message": "OK"})}


def _derive_experiment_id(zip_key):
    """Derive experiment ID from zip key.

    experiments/20260216_wai-nsfw-v16/somefile.zip -> 20260216_wai-nsfw-v16/somefile
    """
    # Strip 'experiments/' prefix and '.zip' extension
    stripped = zip_key
    if stripped.startswith("experiments/"):
        stripped = stripped[len("experiments/"):]
    if stripped.endswith(".zip"):
        stripped = stripped[:-4]
    return stripped


def _process_zip(s3, zip_key):
    """Download, extract, and upload images with thumbnails."""
    experiment_id = _derive_experiment_id(zip_key)
    gallery_prefix = f"gallery/experiments/{experiment_id}"

    logger.info("Experiment ID: %s, gallery prefix: %s", experiment_id, gallery_prefix)

    with tempfile.TemporaryDirectory() as tmpdir:
        zip_path = os.path.join(tmpdir, "archive.zip")
        extract_dir = os.path.join(tmpdir, "extracted")

        # Download zip
        logger.info("Downloading %s", zip_key)
        zip_bytes = s3.get_object(zip_key)
        with open(zip_path, "wb") as f:
            f.write(zip_bytes)

        # Extract
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(extract_dir)

        # Walk extracted files
        metadata = {}
        image_count = 0
        extracted_path = Path(extract_dir)

        for file_path in sorted(extracted_path.rglob("*")):
            if not file_path.is_file():
                continue

            relative = file_path.relative_to(extracted_path)
            name = file_path.name
            suffix = file_path.suffix.lower()

            # Handle metadata.json
            if name == "metadata.json":
                with open(file_path, "r", encoding="utf-8") as f:
                    metadata = json.load(f)
                s3.put_object(
                    f"{gallery_prefix}/metadata.json",
                    file_path.read_bytes(),
                    content_type="application/json",
                )
                logger.info("Uploaded metadata.json")
                continue

            # Handle images
            if suffix in IMAGE_EXTENSIONS:
                image_bytes = file_path.read_bytes()
                image_count += 1

                # Determine content type
                content_types = {
                    ".png": "image/png",
                    ".jpg": "image/jpeg",
                    ".jpeg": "image/jpeg",
                    ".webp": "image/webp",
                }
                content_type = content_types.get(suffix, "application/octet-stream")

                # Upload original to full/
                full_key = f"{gallery_prefix}/full/{name}"
                s3.put_object(full_key, image_bytes, content_type=content_type)

                # Generate and upload thumbnail to thumb/
                stem = file_path.stem
                thumb_key = f"{gallery_prefix}/thumb/{stem}.webp"
                try:
                    thumb_bytes = generate_thumbnail(image_bytes)
                    s3.put_object(thumb_key, thumb_bytes, content_type="image/webp")
                except Exception:
                    logger.exception("Failed to generate thumbnail for %s", name)

                logger.info("Uploaded image %d: %s", image_count, name)

        # Update index
        if not metadata:
            metadata = {}
        metadata.setdefault("image_count", image_count)

        # Auto-infer genre if not present
        if not metadata.get("genre"):
            try:
                from services.genre_inference import infer_genre
                prompt_text = ""
                prompt = metadata.get("prompt", {})
                if isinstance(prompt, dict):
                    prompt_text = prompt.get("positive", "")
                elif isinstance(prompt, str):
                    prompt_text = prompt
                if prompt_text:
                    genre_result = infer_genre(prompt_text, metadata.get("prompt_summary", ""))
                    if genre_result:
                        metadata["genre"] = genre_result.get("genre_en", "")
                        metadata["genre_ja"] = genre_result.get("genre", "")
                        metadata["tags"] = genre_result.get("tags", [])
                        metadata["nsfw_level"] = genre_result.get("nsfw_level", "")
                        # Re-upload metadata with genre info
                        s3.put_object(
                            f"{gallery_prefix}/metadata.json",
                            json.dumps(metadata, ensure_ascii=False, indent=2).encode(),
                            content_type="application/json",
                        )
                        logger.info("Genre inferred: %s (%s)", metadata.get("genre"), metadata.get("genre_ja"))
            except Exception:
                logger.exception("Genre inference failed (non-fatal)")

        update_index(s3, experiment_id, metadata)

        logger.info(
            "Zip processing complete: %s (%d images)", experiment_id, image_count
        )
