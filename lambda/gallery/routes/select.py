import json
import logging

from services.s3_client import S3Client

logger = logging.getLogger(__name__)

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
}

LABELS_KEY = "training-data/labels.json"


def _response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": CORS_HEADERS,
        "body": json.dumps(body, ensure_ascii=False),
    }


def select_images(event):
    """Copy selected images from experiment to production, or save to training data."""
    s3 = S3Client()

    body = event.get("body", "{}")
    if event.get("isBase64Encoded"):
        import base64
        body = base64.b64decode(body).decode("utf-8")

    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return _response(400, {"error": "Invalid JSON body"})

    action = data.get("action", "select")

    if action == "save-training":
        return _save_to_training(s3, data)
    elif action == "delete-experiment":
        return _delete_experiment(s3, data)
    else:
        return _select_to_production(s3, data)


def _select_to_production(s3, data):
    """Original behavior: copy images from experiment to production."""
    experiment_id = data.get("experiment_id")
    production_id = data.get("production_id")
    images = data.get("images", [])

    if not experiment_id or not production_id:
        return _response(400, {"error": "experiment_id and production_id are required"})

    if not images:
        return _response(400, {"error": "images list is required"})

    copied = []
    errors = []
    for image_name in images:
        src = f"gallery/experiments/{experiment_id}/full/{image_name}"
        dst = f"productions/{production_id}/selected/{image_name}"
        try:
            s3.copy_object(src, dst)
            copied.append(image_name)
            logger.info("Copied %s -> %s", src, dst)
        except Exception as e:
            logger.error("Failed to copy %s: %s", src, e)
            errors.append({"image": image_name, "error": str(e)})

    return _response(200, {
        "copied": copied,
        "errors": errors,
        "total_copied": len(copied),
    })


def _save_to_training(s3, data):
    """Save images to training-data/ with labels and update labels.json."""
    experiment_id = data.get("experiment_id")
    images = data.get("images", [])
    labels = data.get("labels", [])
    metadata = data.get("metadata", {})

    if not experiment_id:
        return _response(400, {"error": "experiment_id is required"})
    if not images:
        return _response(400, {"error": "images list is required"})
    if not labels:
        return _response(400, {"error": "labels list is required"})

    # Extract model name from experiment_id (e.g. "20260215_wai-nsfw-v16/baseline")
    parts = experiment_id.split("/")[0].split("_", 1)
    model_name = parts[1] if len(parts) > 1 else experiment_id

    # Load existing labels.json
    try:
        labels_data = s3.get_json(LABELS_KEY)
    except Exception:
        labels_data = {}

    copied = []
    errors = []
    now = _now_iso()

    for image_name in images:
        src = f"gallery/experiments/{experiment_id}/full/{image_name}"

        for label in labels:
            dst = f"training-data/{model_name}/{label}/{image_name}"
            try:
                s3.copy_object(src, dst)
                copied.append(dst)
                logger.info("Training copy %s -> %s", src, dst)

                # Update labels.json
                labels_data[dst] = {
                    "source_experiment": experiment_id,
                    "labels": labels,
                    "scores": metadata.get("scores", {}),
                    "comment": metadata.get("comment", ""),
                    "saved_at": now,
                }
            except Exception as e:
                logger.error("Failed to copy %s to %s: %s", src, dst, e)
                errors.append({"image": image_name, "label": label, "error": str(e)})

    # Save updated labels.json
    try:
        s3.put_json(LABELS_KEY, labels_data)
        logger.info("Updated labels.json: %d entries", len(labels_data))
    except Exception as e:
        logger.error("Failed to update labels.json: %s", e)

    return _response(200, {
        "copied": copied,
        "errors": errors,
        "total_copied": len(copied),
    })


def _delete_experiment(s3, data):
    """Delete an experiment's gallery data and update index."""
    experiment_id = data.get("experiment_id")
    if not experiment_id:
        return _response(400, {"error": "experiment_id is required"})

    prefix = f"gallery/experiments/{experiment_id}/"
    try:
        keys = s3.list_objects(prefix)
        for key in keys:
            s3.delete_object(key)
        logger.info("Deleted %d objects from %s", len(keys), prefix)
    except Exception as e:
        logger.error("Failed to delete %s: %s", prefix, e)
        return _response(500, {"error": f"Failed to delete: {e}"})

    # Remove from index
    try:
        from services.index_builder import INDEX_KEY
        index = s3.get_json(INDEX_KEY)
        if isinstance(index, list):
            index = [e for e in index if e.get("id") != experiment_id]
            s3.put_json(INDEX_KEY, index)
            logger.info("Removed %s from index", experiment_id)
    except Exception as e:
        logger.error("Failed to update index: %s", e)

    return _response(200, {"deleted": experiment_id, "objects_deleted": len(keys)})


def _now_iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
