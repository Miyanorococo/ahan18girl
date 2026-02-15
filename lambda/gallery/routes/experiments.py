import json
import logging

from services.s3_client import S3Client
from services.index_builder import build_index

logger = logging.getLogger(__name__)

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
}


def _response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": CORS_HEADERS,
        "body": json.dumps(body, ensure_ascii=False),
    }


def list_experiments(event):
    """List all experiments from the index."""
    s3 = S3Client()
    index = s3.get_json("gallery/experiments/index.json")

    if not index:
        logger.info("Index not found, building from scratch")
        index = build_index(s3)

    if not isinstance(index, list):
        index = []

    return _response(200, {"experiments": index})


def get_experiment(event, experiment_id):
    """Get a single experiment with its images."""
    s3 = S3Client()

    metadata_key = f"gallery/experiments/{experiment_id}/metadata.json"
    metadata = s3.get_json(metadata_key)

    if not metadata:
        # Try to see if the experiment exists by listing thumbnails
        thumbs = s3.list_objects(f"gallery/experiments/{experiment_id}/thumb/")
        if not thumbs:
            return _response(404, {"error": f"Experiment not found: {experiment_id}"})
        metadata = {}

    # List thumbnail and full images
    thumb_keys = s3.list_objects(f"gallery/experiments/{experiment_id}/thumb/")
    full_keys = s3.list_objects(f"gallery/experiments/{experiment_id}/full/")

    thumb_keys.sort()
    full_keys.sort()

    # Build image list by matching thumb and full images
    full_map = {}
    for key in full_keys:
        name = key.rsplit("/", 1)[-1]
        full_map[name.rsplit(".", 1)[0]] = "/" + key

    images = []
    for key in thumb_keys:
        name = key.rsplit("/", 1)[-1]
        stem = name.rsplit(".", 1)[0]
        images.append({
            "name": name,
            "thumb_url": "/" + key,
            "full_url": full_map.get(stem, ""),
        })

    # Include full images that have no thumbnail
    thumb_stems = {k.rsplit("/", 1)[-1].rsplit(".", 1)[0] for k in thumb_keys}
    for key in full_keys:
        name = key.rsplit("/", 1)[-1]
        stem = name.rsplit(".", 1)[0]
        if stem not in thumb_stems:
            images.append({
                "name": name,
                "thumb_url": "",
                "full_url": "/" + key,
            })

    return _response(200, {
        "id": experiment_id,
        "metadata": metadata,
        "images": images,
        "image_count": len(images),
    })
