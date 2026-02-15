import json
import logging
import re

from routes import experiments, productions, ratings, select, extract

logger = logging.getLogger()
logger.setLevel(logging.INFO)

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}


def make_response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {**CORS_HEADERS, "Content-Type": "application/json"},
        "body": json.dumps(body, ensure_ascii=False),
    }


def handler(event, context):
    # S3 event trigger
    records = event.get("Records", [])
    if records and records[0].get("eventSource") == "aws:s3":
        logger.info("Handling S3 event")
        return extract.handle_s3_event(event)

    # API request via Function URL
    request_context = event.get("requestContext", {})
    http_info = request_context.get("http", {})
    method = http_info.get("method", "")
    path = http_info.get("path", "")

    logger.info("Handling API request: %s %s", method, path)

    if method == "OPTIONS":
        return make_response(204, "")

    try:
        return route(method, path, event)
    except Exception:
        logger.exception("Unhandled error")
        return make_response(500, {"error": "Internal server error"})


def route(method, path, event):
    # GET /api/experiments
    if method == "GET" and path == "/api/experiments":
        return experiments.list_experiments(event)

    # GET /api/experiments/{id} — id may contain slashes
    m = re.match(r"^/api/experiments/(.+)$", path)
    if method == "GET" and m:
        return experiments.get_experiment(event, m.group(1))

    # GET /api/productions
    if method == "GET" and path == "/api/productions":
        return productions.list_productions(event)

    # GET /api/productions/{id}
    m = re.match(r"^/api/productions/(.+)$", path)
    if method == "GET" and m:
        return productions.get_production(event, m.group(1))

    # GET /api/ratings
    if method == "GET" and path == "/api/ratings":
        return ratings.get_ratings(event)

    # PUT /api/ratings
    if method == "PUT" and path == "/api/ratings":
        return ratings.put_ratings(event)

    # POST /api/select
    if method == "POST" and path == "/api/select":
        return select.select_images(event)

    # POST /api/infer-genre
    if method == "POST" and path == "/api/infer-genre":
        return _infer_genre(event)

    # POST /api/score-experiment
    if method == "POST" and path == "/api/score-experiment":
        return _score_experiment(event)

    return make_response(404, {"error": f"Not found: {method} {path}"})


def _infer_genre(event):
    """Infer genre from prompt text using Bedrock."""
    import json as _json
    from services.genre_inference import infer_genre

    body = event.get("body", "{}")
    try:
        data = _json.loads(body) if isinstance(body, str) else body
    except _json.JSONDecodeError:
        return make_response(400, {"error": "Invalid JSON"})

    prompt_text = data.get("prompt_text", "")
    prompt_summary = data.get("prompt_summary", "")

    result = infer_genre(prompt_text, prompt_summary)
    if result:
        return make_response(200, result)
    return make_response(500, {"error": "Genre inference failed"})


def _score_experiment(event):
    """Score all images in an experiment with anime-aesthetic ONNX."""
    import json as _json
    from services.s3_client import S3Client
    from services.image_scorer import score_images
    body = event.get("body", "{}")
    try:
        data = _json.loads(body) if isinstance(body, str) else body
    except _json.JSONDecodeError:
        return make_response(400, {"error": "Invalid JSON"})

    experiment_id = data.get("experiment_id", "")
    if not experiment_id:
        return make_response(400, {"error": "experiment_id required"})

    s3 = S3Client()
    gallery_prefix = f"gallery/experiments/{experiment_id}"

    # Read metadata
    try:
        meta = s3.get_json(f"{gallery_prefix}/metadata.json")
    except Exception:
        meta = {}

    # Skip if already scored (unless force=true)
    if not data.get("force") and meta.get("aesthetic_avg") is not None:
        return make_response(200, {"status": "already_scored", "aesthetic_avg": meta["aesthetic_avg"]})

    # List images
    image_keys = s3.list_objects(f"{gallery_prefix}/full/")
    if not image_keys:
        image_keys = s3.list_objects(f"{gallery_prefix}/thumb/")
    image_keys = [k for k in image_keys if k.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))]

    if not image_keys:
        return make_response(404, {"error": "No images found"})

    # Score
    image_list = []
    for key in image_keys:
        try:
            img_bytes = s3.get_object(key)
            name = key.rsplit("/", 1)[-1]
            image_list.append((name, img_bytes))
        except Exception:
            pass

    scores = score_images(s3, image_list)
    if not scores:
        return make_response(500, {"error": "Scoring failed"})

    avg = round(sum(scores.values()) / len(scores), 4)
    meta["aesthetic_scores"] = scores
    meta["aesthetic_avg"] = avg
    s3.put_json(f"{gallery_prefix}/metadata.json", meta)
    # Skip index update here - caller should rebuild index once after all scoring is done
    # This avoids S3 write conflicts when scoring many experiments in parallel

    return make_response(200, {"status": "scored", "aesthetic_avg": avg, "count": len(scores)})
