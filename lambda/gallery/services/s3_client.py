import json
import logging
import os

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

BUCKET = os.environ.get("S3_BUCKET", "r18-anime-assets")


class S3Client:
    def __init__(self, bucket=None):
        self.s3 = boto3.client("s3")
        self.bucket = bucket or BUCKET

    def get_object(self, key):
        resp = self.s3.get_object(Bucket=self.bucket, Key=key)
        return resp["Body"].read()

    def put_object(self, key, body, content_type="application/octet-stream"):
        self.s3.put_object(
            Bucket=self.bucket, Key=key, Body=body, ContentType=content_type
        )

    def list_objects(self, prefix):
        keys = []
        paginator = self.s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                keys.append(obj["Key"])
        return keys

    def copy_object(self, src_key, dst_key):
        self.s3.copy_object(
            Bucket=self.bucket,
            CopySource={"Bucket": self.bucket, "Key": src_key},
            Key=dst_key,
        )

    def get_json(self, key):
        try:
            data = self.get_object(key)
            return json.loads(data)
        except ClientError as e:
            if e.response["Error"]["Code"] == "NoSuchKey":
                return {}
            raise

    def put_json(self, key, data):
        body = json.dumps(data, ensure_ascii=False, indent=2)
        self.put_object(key, body.encode("utf-8"), content_type="application/json")
