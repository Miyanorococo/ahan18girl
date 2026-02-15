import json
import logging

from services.s3_client import S3Client

logger = logging.getLogger(__name__)

RATINGS_KEY = "gallery/user-data/ratings.json"

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


def get_ratings(event):
    """Read ratings data."""
    s3 = S3Client()
    data = s3.get_json(RATINGS_KEY)
    return _response(200, data)


def put_ratings(event):
    """Write ratings data."""
    s3 = S3Client()

    body = event.get("body", "{}")
    if event.get("isBase64Encoded"):
        import base64
        body = base64.b64decode(body).decode("utf-8")

    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return _response(400, {"error": "Invalid JSON body"})

    s3.put_json(RATINGS_KEY, data)
    logger.info("Ratings updated: %d entries", len(data))
    return _response(200, {"message": "Ratings saved", "count": len(data)})
