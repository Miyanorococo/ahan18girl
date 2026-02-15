import logging
import re
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

INDEX_KEY = "gallery/experiments/index.json"


def _extract_info_from_id(experiment_id):
    """Extract model name and date from experiment ID like '20260216_wai-nsfw-v16/basename'."""
    parts = experiment_id.split("/")
    dir_part = parts[0]  # e.g. '20260216_wai-nsfw-v16'
    m = re.match(r"^(\d{8})_(.+)$", dir_part)
    if m:
        date_str = m.group(1)
        model = m.group(2)
        date = f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
        return model, date
    return dir_part, None


def _build_entry(s3_client, experiment_id, metadata):
    """Build an index entry for a single experiment."""
    model, date = _extract_info_from_id(experiment_id)

    # Count images in thumb dir
    prefix = f"gallery/experiments/{experiment_id}/thumb/"
    thumbs = s3_client.list_objects(prefix)
    image_count = len(thumbs)

    thumbnail = ""
    if thumbs:
        first_thumb = sorted(thumbs)[0]
        thumbnail = "/" + first_thumb

    # model can be a string or dict like {"checkpoint": "wai-nsfw-v16"}
    meta_model = metadata.get("model", model)
    if isinstance(meta_model, dict):
        meta_model = meta_model.get("checkpoint", model)

    # Extract prompt summary: metadata > experiment_id > positive prompt fallback
    prompt_summary = metadata.get("prompt_summary", "")
    if not prompt_summary:
        # Try to extract from experiment_id: {date}_{model}/{date}_{model}_txt2img_{summary}_...
        # or {date}_{model}/{prompt_id}
        basename = experiment_id.split("/")[-1] if "/" in experiment_id else ""
        if "_txt2img_" in basename:
            # e.g. 20260215_wai-nsfw-v16_txt2img_girl-school-uniform_s25-cfg7-euler-a_seed42x5
            after_txt2img = basename.split("_txt2img_", 1)[1]
            # Strip params suffix (starts with _s{digits} or _seed)
            prompt_part = re.split(r"_s\d+[-_]|_seed", after_txt2img)[0]
            if prompt_part:
                prompt_summary = prompt_part
    if not prompt_summary:
        prompt = metadata.get("prompt", {})
        if isinstance(prompt, dict):
            positive = prompt.get("positive", "")
        elif isinstance(prompt, str):
            positive = prompt
        else:
            positive = ""
        if positive:
            words = positive.split(",")[:4]
            prompt_summary = ", ".join(w.strip() for w in words if w.strip())[:80]

    # Extract genre and type for Knowledge Base matrix
    genre = metadata.get("genre", "")
    content_type = metadata.get("type", "")
    if not genre and prompt_summary:
        parts = prompt_summary.split("_", 1)
        genre = parts[0] if parts else ""
    if not content_type and prompt_summary and "_" in prompt_summary:
        content_type = prompt_summary.split("_", 1)[1]

    # Extract prompt_id from experiment_id (e.g., "20260215_model/P01_ex" → "P01_ex")
    prompt_id = ""
    if "/" in experiment_id:
        prompt_id = experiment_id.split("/")[-1]

    return {
        "id": experiment_id,
        "model": meta_model,
        "pipeline": metadata.get("pipeline", "txt2img"),
        "prompt_summary": prompt_summary,
        "genre": genre,
        "genre_ja": metadata.get("genre_ja", ""),
        "content_type": content_type,
        "nsfw_level": metadata.get("nsfw_level", ""),
        "prompt_id": prompt_id,
        "date": metadata.get("date", date or "") or (metadata.get("generated_at", "")[:10] if metadata.get("generated_at") else ""),
        "image_count": image_count,
        "aesthetic_avg": metadata.get("aesthetic_avg"),
        "thumbnail": thumbnail,
        "created_at": metadata.get("created_at", "") or metadata.get("generated_at", "") or datetime.now(timezone.utc).isoformat(),
    }


def build_index(s3_client):
    """Scan all experiments and rebuild the full index."""
    logger.info("Building full experiment index")
    metadata_keys = s3_client.list_objects("gallery/experiments/")
    metadata_keys = [k for k in metadata_keys if k.endswith("/metadata.json")]

    entries = []
    for key in metadata_keys:
        # Extract experiment ID: gallery/experiments/{id}/metadata.json
        # id may contain slashes, e.g. '20260216_wai-nsfw-v16/basename'
        stripped = key[len("gallery/experiments/") : -len("/metadata.json")]
        experiment_id = stripped
        try:
            metadata = s3_client.get_json(key)
            entry = _build_entry(s3_client, experiment_id, metadata)
            entries.append(entry)
        except Exception:
            logger.exception("Failed to process %s", key)

    entries.sort(key=lambda e: e["created_at"], reverse=True)
    s3_client.put_json(INDEX_KEY, entries)
    logger.info("Index built with %d entries", len(entries))
    return entries


def update_index(s3_client, experiment_id, metadata):
    """Add or update a single experiment in the index."""
    index = s3_client.get_json(INDEX_KEY)
    if not isinstance(index, list):
        index = []

    entry = _build_entry(s3_client, experiment_id, metadata)

    # Replace existing entry or append
    updated = False
    for i, existing in enumerate(index):
        if existing["id"] == experiment_id:
            index[i] = entry
            updated = True
            break
    if not updated:
        index.append(entry)

    index.sort(key=lambda e: e["created_at"], reverse=True)
    s3_client.put_json(INDEX_KEY, index)
    logger.info("Index updated for %s", experiment_id)
    return entry
