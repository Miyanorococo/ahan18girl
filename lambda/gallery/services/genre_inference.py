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

SYSTEM_PROMPT = """あなたはアダルトアニメ画像のジャンル分類器です。DLSite・FANZAなどの販売プラットフォームで使われるジャンル分類に従います。

画像生成プロンプトを分析し、以下のJSON形式で返してください。

必須フィールド:
- genre: メインジャンル（■一覧から最適なものを選択。該当なしなら自由に命名）
- genre_en: 英語のジャンル名
- sub_genre: サブジャンル（該当する場合のみ。なければ空文字列）
- tags: DLSiteタグ形式の配列（3-8個。■タグ参照から選択 + 自由追加）
- nsfw_level: "safe" | "sensitive" | "explicit"
- scene: シーンの簡潔な説明（日本語、20文字以内）

■ メインジャンル一覧:
[シチュエーション] 学校/学園, オフィス/職場, 日常/生活, ファンタジー, 温泉/風呂, 野外/露出, 風俗/ソープ, ハーレム, 純愛, 寝取られ/NTR, 百合, 催眠/洗脳, 時間停止
[プレイ] ヌード/裸体, フェラチオ, パイズリ, 騎乗位, 中出し, 触手, アナル, オナニー, 複数/乱交, 搾乳/母乳, 妊娠/孕ませ, 出産, 拘束/緊縛
[キャラ/衣装] 制服/セーラー服, 人妻/熟女, メイド, ナース, OL, 巫女, 水着, ランジェリー/下着, 和服/着物, バニーガール, 魔法少女, エルフ/妖精, 人外娘/モンスター娘, ギャル
[身体] 巨乳/爆乳, 貧乳/微乳, 褐色/日焼け, ぼて腹/妊婦
[日常/SFW] カフェ, ポートレート, 風景, 着替え

ジャンル選択の優先度: プレイ内容 > シチュエーション > キャラ/衣装 > 身体特徴
（例: 「メイドが騎乗位」→ genre=騎乗位, sub_genre=メイド）
ただしプレイがなくキャラ/衣装が主体なら衣装をgenreにする
（例: 「メイドがポーズ」→ genre=メイド）

■ タグ参照（複数選択可、上記以外も自由に追加OK）:
汗, 赤面, 涙, アヘ顔, 潮吹き, おっぱい, お尻, 太もも, 腋,
ベッド, 教室, 屋上, 浴室, キッチン, 図書室, 電車,
朝, 昼, 夜, 月明かり, 夕焼け,
見つめる, 誘惑, 恥じらい, 笑顔, 無表情

「アダルト」「エロティック」「NSFW」「hentai」のような汎用ジャンル名は禁止。
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
