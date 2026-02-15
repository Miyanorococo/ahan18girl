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

    return make_response(404, {"error": f"Not found: {method} {path}"})
