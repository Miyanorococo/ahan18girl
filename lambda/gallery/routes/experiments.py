import base64
import json
import logging
import os
import re
import time

from services.s3_client import S3Client
from services.index_builder import build_index, INDEX_KEY

logger = logging.getLogger(__name__)

CORS_HEADERS = {
    "Access-Control-Allow-Origin": os.environ.get("CORS_ORIGIN", "*"),
    "Content-Type": "application/json",
}

# --- Lambda warm-container cache (5 min TTL) ---
_cached_index = None
_cached_at = 0
_CACHE_TTL = 300


def _get_index(s3):
    """Return index from cache if fresh, otherwise fetch from S3."""
    global _cached_index, _cached_at
    now = time.time()
    if _cached_index is not None and (now - _cached_at) < _CACHE_TTL:
        return _cached_index
    _cached_index = s3.get_json(INDEX_KEY)
    if not isinstance(_cached_index, list):
        _cached_index = []
    _cached_at = now
    return _cached_index


def invalidate_cache():
    """Called after index writes to force next read from S3."""
    global _cached_index, _cached_at
    _cached_index = None
    _cached_at = 0


def _response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": CORS_HEADERS,
        "body": json.dumps(body, ensure_ascii=False),
    }


def _safe_int(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


_SAFE_ID_RE = re.compile(r'^[\w./-]+$')
_BOOK_ID_RE = re.compile(r'^(\d{4}[a-z]+)_')


def _validate_experiment_id(experiment_id):
    return bool(experiment_id) and '..' not in experiment_id and bool(_SAFE_ID_RE.match(experiment_id))


def _extract_book_id(prompt_id):
    m = _BOOK_ID_RE.match(prompt_id or "")
    return m.group(1) if m else ""


# --- API handlers ---


def list_experiments(event):
    """List experiments with optional server-side filtering and cursor pagination."""
    s3 = S3Client()
    index = _get_index(s3)

    if not index:
        logger.info("Index empty, triggering rebuild")
        index = build_index(s3)
        invalidate_cache()
        if not index:
            return _response(200, {"experiments": [], "total": 0})

    params = event.get("queryStringParameters") or {}
    book = params.get("book")
    model = params.get("model")
    genre = params.get("genre")
    prompt_id = params.get("prompt_id")
    search = params.get("search")
    limit = min(_safe_int(params.get("limit"), 100), 500)
    cursor = params.get("cursor")

    filtered = index
    if book:
        filtered = [e for e in filtered if (e.get("prompt_id") or "").startswith(book + "_")]
    if model:
        filtered = [e for e in filtered if e.get("model") == model]
    if genre:
        filtered = [e for e in filtered if e.get("genre") == genre]
    if prompt_id:
        filtered = [e for e in filtered if e.get("prompt_id") == prompt_id]
    if search:
        q = search.lower()
        filtered = [e for e in filtered
                    if q in (e.get("prompt_summary") or "").lower()
                    or q in (e.get("model") or "").lower()]

    total = len(filtered)

    start_idx = 0
    if cursor:
        try:
            start_idx = int(base64.b64decode(cursor).decode())
        except Exception:
            start_idx = 0

    page = filtered[start_idx:start_idx + limit]

    result = {"experiments": page, "total": total, "count": len(page)}
    end_idx = start_idx + limit
    if end_idx < total:
        result["nextCursor"] = base64.b64encode(str(end_idx).encode()).decode()

    # Include filter options on unfiltered requests (for dropdown population)
    if not any([book, model, genre, prompt_id, search]):
        models = sorted({e.get("model", "") for e in index if e.get("model")})
        genres = sorted({e.get("genre", "") for e in index if e.get("genre")})
        result["availableModels"] = models
        result["availableGenres"] = genres

    return _response(200, result)


def list_books(event):
    """Book summary list, aggregated from cached index."""
    s3 = S3Client()
    index = _get_index(s3)

    book_map = {}
    for e in index:
        bid = _extract_book_id(e.get("prompt_id", ""))
        if not bid:
            continue
        if bid not in book_map:
            book_map[bid] = {
                "id": bid, "date": e.get("date", ""),
                "models": set(), "scenes": set(),
                "count": 0, "genre": e.get("genre", ""),
                "thumbnail": e.get("thumbnail", ""),
            }
        b = book_map[bid]
        b["models"].add(e.get("model", ""))
        b["scenes"].add(e.get("prompt_id", ""))
        b["count"] += 1
        if e.get("date", "") > b["date"]:
            b["date"] = e["date"]

    books = [
        {
            "id": bid,
            "date": b["date"],
            "model_count": len(b["models"]),
            "scene_count": len(b["scenes"]),
            "total_experiments": b["count"],
            "genre": b["genre"],
            "thumbnail": b["thumbnail"],
        }
        for bid, b in book_map.items()
    ]
    books.sort(key=lambda x: x["date"], reverse=True)

    return _response(200, {"books": books, "unassigned_count": sum(
        1 for e in index if not _extract_book_id(e.get("prompt_id", ""))
    )})


def get_experiment(event, experiment_id):
    """Get a single experiment with its images."""
    if not _validate_experiment_id(experiment_id):
        return _response(400, {"error": "Invalid experiment ID"})

    s3 = S3Client()

    metadata_key = f"gallery/experiments/{experiment_id}/metadata.json"
    metadata = s3.get_json(metadata_key)

    if not metadata:
        thumbs = s3.list_objects(f"gallery/experiments/{experiment_id}/thumb/")
        if not thumbs:
            return _response(404, {"error": f"Experiment not found: {experiment_id}"})
        metadata = {}

    thumb_keys = s3.list_objects(f"gallery/experiments/{experiment_id}/thumb/")
    full_keys = s3.list_objects(f"gallery/experiments/{experiment_id}/full/")

    thumb_keys.sort()
    full_keys.sort()

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

    thumb_stems = {k.rsplit("/", 1)[-1].rsplit(".", 1)[0] for k in thumb_keys}
    for key in full_keys:
        name = key.rsplit("/", 1)[-1]
        stem = name.rsplit(".", 1)[0]
        if stem not in thumb_stems:
            images.append({"name": name, "thumb_url": "", "full_url": "/" + key})

    return _response(200, {
        "id": experiment_id,
        "metadata": metadata,
        "images": images,
        "image_count": len(images),
    })
