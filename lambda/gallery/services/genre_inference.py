"""Genre inference using Amazon Bedrock with model fallback chain."""
import json
import logging

import boto3

logger = logging.getLogger(__name__)

REGION = "us-east-1"

# Fallback chain: cheapest Anthropic first. Nova models are excluded because
# they refuse to classify NSFW content (return empty responses).
MODEL_CHAIN = [
    {
        "id": "anthropic.claude-3-haiku-20240307-v1:0",
        "format": "anthropic",  # $0.25/1M input, $1.25/1M output
    },
    {
        "id": "anthropic.claude-3-5-haiku-20241022-v1:0",
        "format": "anthropic",  # $0.80/1M input, $4/1M output
    },
    {
        "id": "anthropic.claude-haiku-4-5-20251001-v1:0",
        "format": "anthropic",  # newest Haiku
    },
]

SYSTEM_PROMPT = """あなたはAI生成アニメ画像のジャンル分類器です。
画像生成プロンプトを分析し、以下の情報をJSON形式で返してください。

必須フィールド:
- genre: メインジャンル（日本語、簡潔に。例: "制服", "ランジェリー", "ヌード", "人妻", "温泉", "カフェ" など）
- genre_en: 英語のジャンル名（例: "school", "lingerie", "nude", "housewife", "onsen", "cafe"）
- tags: 関連タグの配列（3-6個。シチュエーション、衣装、場所、雰囲気など）
- nsfw_level: "safe" | "sensitive" | "explicit"
- scene: シーンの簡潔な説明（日本語、20文字以内）

ジャンルは具体的かつ実用的に。「アニメ」のような汎用ジャンルは避ける。
JSONのみ返し、他のテキストは含めない。"""


def _build_anthropic_body(system, user_msg):
    return json.dumps({
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 300,
        "system": system,
        "messages": [{"role": "user", "content": user_msg}],
    })


def _build_nova_body(system, user_msg):
    return json.dumps({
        "schemaVersion": "messages-v1",
        "system": [{"text": system}],
        "messages": [{"role": "user", "content": [{"text": user_msg}]}],
        "inferenceConfig": {"maxTokens": 300, "temperature": 0.1},
    })


def _parse_anthropic_response(body):
    result = json.loads(body)
    return result["content"][0]["text"].strip()


def _parse_nova_response(body):
    result = json.loads(body)
    return result["output"]["message"]["content"][0]["text"].strip()


BUILDERS = {
    "anthropic": (_build_anthropic_body, _parse_anthropic_response),
    "nova": (_build_nova_body, _parse_nova_response),
}


def infer_genre(prompt_text, prompt_summary=""):
    """Analyze prompt text and return genre classification.

    Tries models in fallback order. Each model failure
    (deprecated, throttled, etc.) falls through to the next.
    """
    if not prompt_text and not prompt_summary:
        return None

    user_msg = f"プロンプト: {prompt_text[:1000]}"
    if prompt_summary:
        user_msg = f"サマリー: {prompt_summary}\n{user_msg}"

    client = boto3.client("bedrock-runtime", region_name=REGION)

    for model in MODEL_CHAIN:
        model_id = model["id"]
        fmt = model["format"]
        build_body, parse_resp = BUILDERS[fmt]

        try:
            logger.info("Trying model: %s", model_id)
            response = client.invoke_model(
                modelId=model_id,
                contentType="application/json",
                accept="application/json",
                body=build_body(SYSTEM_PROMPT, user_msg),
            )
            text = parse_resp(response["body"].read())

            # Strip markdown fences if present
            if text.startswith("```"):
                text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()

            parsed = json.loads(text)
            logger.info("Genre inferred via %s: %s", model_id, parsed.get("genre_en", "?"))
            parsed["_model"] = model_id  # track which model was used
            return parsed

        except json.JSONDecodeError:
            logger.warning("Model %s returned non-JSON: %s", model_id, text[:200])
            continue  # try next model
        except client.exceptions.ValidationException as e:
            logger.warning("Model %s validation error (possibly deprecated): %s", model_id, e)
            continue
        except client.exceptions.AccessDeniedException as e:
            logger.warning("Model %s access denied: %s", model_id, e)
            continue
        except Exception as e:
            logger.error("Model %s failed: %s", model_id, e)
            continue

    logger.error("All models in fallback chain failed")
    return None
