"""Genre inference using Amazon Bedrock (Claude 3 Haiku)."""
import json
import logging

import boto3

logger = logging.getLogger(__name__)

MODEL_ID = "anthropic.claude-3-haiku-20240307-v1:0"
REGION = "us-east-1"

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


def infer_genre(prompt_text, prompt_summary=""):
    """Analyze prompt text and return genre classification."""
    if not prompt_text and not prompt_summary:
        return None

    user_msg = f"プロンプト: {prompt_text[:1000]}"
    if prompt_summary:
        user_msg = f"サマリー: {prompt_summary}\n{user_msg}"

    try:
        client = boto3.client("bedrock-runtime", region_name=REGION)
        response = client.invoke_model(
            modelId=MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 300,
                "system": SYSTEM_PROMPT,
                "messages": [{"role": "user", "content": user_msg}],
            }),
        )
        result = json.loads(response["body"].read())
        text = result["content"][0]["text"].strip()

        # Parse JSON from response
        parsed = json.loads(text)
        logger.info("Genre inferred: %s", parsed.get("genre_en", "?"))
        return parsed
    except json.JSONDecodeError:
        logger.warning("Failed to parse Bedrock response as JSON: %s", text[:200])
        return None
    except Exception as e:
        logger.error("Bedrock inference failed: %s", e)
        return None
