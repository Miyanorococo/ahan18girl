import json
import logging

from services.s3_client import S3Client

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


def list_productions(event):
    """List all productions."""
    s3 = S3Client()
    keys = s3.list_objects("productions/")

    # Extract unique production IDs from keys like productions/{id}/...
    production_ids = set()
    for key in keys:
        parts = key[len("productions/"):].split("/")
        if len(parts) >= 2:
            production_ids.add(parts[0])

    productions = []
    for pid in sorted(production_ids):
        # Count images in each stage
        raw_keys = [k for k in keys if k.startswith(f"productions/{pid}/raw/")]
        selected_keys = [k for k in keys if k.startswith(f"productions/{pid}/selected/")]
        final_keys = [k for k in keys if k.startswith(f"productions/{pid}/final/")]

        productions.append({
            "id": pid,
            "raw_count": len(raw_keys),
            "selected_count": len(selected_keys),
            "final_count": len(final_keys),
        })

    return _response(200, {"productions": productions})


def get_production(event, production_id):
    """Get a single production with images grouped by stage."""
    s3 = S3Client()
    prefix = f"productions/{production_id}/"
    keys = s3.list_objects(prefix)

    if not keys:
        return _response(404, {"error": f"Production not found: {production_id}"})

    stages = {"raw": [], "selected": [], "final": []}
    for key in sorted(keys):
        relative = key[len(prefix):]
        parts = relative.split("/", 1)
        if len(parts) == 2 and parts[0] in stages:
            stage = parts[0]
            name = parts[1]
            stages[stage].append({
                "name": name,
                "url": "/" + key,
            })

    return _response(200, {
        "id": production_id,
        "stages": stages,
    })
