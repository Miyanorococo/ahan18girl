"""Genre inference using Amazon Bedrock with model fallback chain."""
import json
import logging

import boto3

logger = logging.getLogger(__name__)

REGION = "us-east-1"

# Fallback chain: best quality first. Nova models excluded (refuse NSFW).
# Haiku 3.5/4.5 require inference profiles (us.* prefix).
# Haiku 3 works with direct on-demand model ID.
MODEL_CHAIN = [
    {
        "id": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        "format": "anthropic",  # best accuracy, ~$0.00080/call
    },
    {
        "id": "us.anthropic.claude-3-5-haiku-20241022-v1:0",
        "format": "anthropic",  # good accuracy, ~$0.00080/call
    },
    {
        "id": "anthropic.claude-3-haiku-20240307-v1:0",
        "format": "anthropic",  # cheapest, ~$0.00025/call, adequate accuracy
    },
]

SYSTEM_PROMPT = """あなたはアダルトアニメ画像のジャンル分類器です。FANZA・DLSiteなどの販売プラットフォームで使われるジャンル分類に従います。

画像生成プロンプトを分析し、以下のJSON形式で返してください。

必須フィールド:
- genre: メインジャンル（以下のジャンル一覧から最も適切なものを選択）
- genre_en: 英語のジャンル名
- sub_genre: サブジャンル（該当する場合のみ）
- tags: 関連タグの配列（3-6個）
- nsfw_level: "safe" | "sensitive" | "explicit"
- scene: シーンの簡潔な説明（日本語、20文字以内）

■ ジャンル一覧（優先的に使用すること）:
制服/学園, 人妻/熟女, メイド, ナース, OL/オフィス, 巨乳, 貧乳,
水着/ビーチ, 温泉/風呂, ランジェリー/下着, 和服/着物,
ヌード/裸体, 触手, ファンタジー, 異種姦, 催眠/洗脳, 寝取られ/NTR,
ハーレム, 百合/レズ, 妊婦, 母乳, アナル,
野外/露出, カフェ/日常, 学校/放課後, ダンジョン,
フェラ/口内, パイズリ, 騎乗位, バック, 中出し/射精

上記に該当しない場合は適切なジャンル名を自由に付けてください。
「アダルト」「エロティック」「NSFW」のような汎用的すぎるジャンル名は使わないこと。
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
