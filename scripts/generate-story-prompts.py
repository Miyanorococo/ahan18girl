#!/usr/bin/env python3
"""
ストーリーテンプレートからプロンプトファイルを生成。
キャラクター定義を差し替えるだけで量産可能。

Usage:
  python3 scripts/generate-story-prompts.py characters/jk.json -o assets/templates/eval-prompts-prod-jk.json
  python3 scripts/generate-story-prompts.py characters/wife.json -o assets/templates/eval-prompts-prod-wife.json
"""
import json
import argparse
import sys
import os

# Base model groups (loaded from existing file or hardcoded)
DEFAULT_MODEL_GROUPS_FILE = "assets/templates/eval-prompts-v2-unified-anime.json"


def load_model_groups(base_file):
    with open(base_file) as f:
        data = json.load(f)
    return data["model_groups"], data["negative_common"]


def build_story_prompts(char_config):
    """Build 34 scene prompts from character config."""
    C = char_config
    CHAR = C["char_tags"]
    CHAR_OUTFIT = C.get("char_outfit", CHAR)
    GENRE = C["genre"]

    # Location templates
    LOC = C.get("locations", {})
    bedroom = LOC.get("bedroom", "bedroom, warm lighting")
    outdoor1 = LOC.get("date1", "outdoor, park, green trees, sunlight, summer")
    outdoor2 = LOC.get("date2", "outdoor, seaside, sunset, golden hour, orange sky")
    school = LOC.get("school", "school gate, cherry blossoms, spring, sunlight")
    bath = LOC.get("bath", "bathtub, bathroom, warm water lighting")
    hospital = LOC.get("hospital", "hospital bed, bright overhead light")
    future_loc = LOC.get("future", "outdoor, park, cherry blossoms, spring, sunlight, warm tones")
    bonus_loc = LOC.get("bonus", "beach, ocean, summer, sunlight, sand")

    # Outfit variants
    date1_outfit = C.get("date1_outfit", "white sundress, straw hat")
    date2_outfit = C.get("date2_outfit", "casual clothes, off-shoulder sweater, denim skirt")
    casual = C.get("casual_outfit", "casual clothes, tank top, short shorts")
    future_outfit = C.get("future_outfit", "white blouse, long skirt, wedding ring")
    bonus_outfit = C.get("bonus_outfit", "bikini, white bikini")
    maternity = C.get("maternity_outfit", "white maternity dress")

    prompts = [
        # === 導入 ===
        {"id": "S00_cover", "sub": "cover", "type": "sensitive",
         "p": f"nsfw, sensitive, {CHAR_OUTFIT}, standing, wind, floating hair, skirt lift, looking at viewer, smile, blush, {school}, lens flare"},
        {"id": "S01_standing", "sub": "standing_portrait", "type": "sensitive",
         "p": f"nsfw, sensitive, {CHAR_OUTFIT}, standing, arms crossed, looking away, slight frown, cool expression, classroom, window, afternoon light"},
        {"id": "S02_date1", "sub": "date", "type": "safe",
         "p": f"sfw, {CHAR}, {date1_outfit}, holding hat, smile, blush, {outdoor1}, looking at viewer, wind, floating hair"},
        {"id": "S03_date2", "sub": "date", "type": "safe",
         "p": f"sfw, {CHAR}, {date2_outfit}, holding hands, pov, smile, shy, blush, {outdoor2}"},
        
        # === 恥じらい → 初体験 ===
        {"id": "S04_flirting", "sub": "flirting", "type": "sensitive",
         "p": f"nsfw, sensitive, {CHAR}, {casual}, sitting on bed, leaning forward, cleavage, shy smile, blush, looking at viewer, {bedroom}, evening"},
        {"id": "S05_kiss", "sub": "kiss", "type": "sensitive",
         "p": f"nsfw, sensitive, {CHAR}, 1boy, hetero, kiss, french kiss, closed eyes, blush, tears of joy, embrace, holding, {bedroom}, close-up"},
        {"id": "S06a_finger_normal", "sub": "fingering", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, nude, lying on bed, spread legs, fingering, 1boy, hand between legs, blush, embarrassed, looking away, panting, white sheets, {bedroom}"},
        {"id": "S06b_finger_squirt", "sub": "squirting", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, nude, lying on bed, spread legs, fingering, squirting, female ejaculation, 1boy, arched back, ahegao, tongue out, blush, sweat, wet sheets, {bedroom}"},
        {"id": "S07a_oral_normal", "sub": "oral", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, 1boy, fellatio, oral, penis, kneeling, looking up at viewer, blush, embarrassed, saliva, {bedroom}"},
        {"id": "S07b_oral_cum", "sub": "ejaculation", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, 1boy, fellatio, cum in mouth, cum on face, facial, cum dripping, cross-eyed, dazed, blush, kneeling, {bedroom}"},
        
        # === Sex① 驚きの快楽 ===
        {"id": "S08a_sex1_before", "sub": "pre_insertion", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, nude, lying on back, spread legs, 1boy, penis, about to penetrate, nervous, blush, embarrassed, biting lip, looking away, white sheets, {bedroom}"},
        {"id": "S08b_sex1_insert", "sub": "insertion", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, 1boy, sex, vaginal, missionary, lying on back, penetration, spread legs, surprised, open mouth, gasp, blush, gripping sheets, {bedroom}"},
        {"id": "S08c_sex1_pos1", "sub": "sex", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, 1boy, sex, vaginal, missionary, lying on back, legs wrapped, surprised pleasure, wide eyes, blush, panting, sweat, confused expression, unexpected pleasure, {bedroom}"},
        {"id": "S08d_sex1_pos2", "sub": "sex", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, 1boy, sex, vaginal, from behind, doggystyle, twisted torso, looking back, shocked, blush, panting, sweat, embarrassed, trying to hide moans, covering mouth, {bedroom}"},
        {"id": "S08e_sex1_almost", "sub": "orgasm", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, 1boy, sex, vaginal, missionary, arched back, trembling, about to orgasm, eyes wide, panting, sweat, blush, gripping sheets, {bedroom}"},
        {"id": "S08f_sex1_climax", "sub": "orgasm", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, 1boy, sex, vaginal, orgasm, ahegao, rolling eyes, tongue out, surprised by own orgasm, cum, creampie, arched back, trembling, tears of pleasure, sweat, {bedroom}"},
        {"id": "S08g_sex1_after", "sub": "afterglow", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, nude, lying on bed, after sex, cum overflow, cum on thighs, dazed, wide eyes, shocked expression, panting, messy hair, sweat, blush, white sheets, {bedroom}"},
        
        # === 開発 ===
        {"id": "S09_bath", "sub": "bath", "type": "sensitive",
         "p": f"nsfw, sensitive, {CHAR}, nude, bathing, wet hair, wet skin, steam, relaxed, gentle smile, blush, soap bubbles, {bath}"},
        {"id": "S10a_toy_normal", "sub": "toy", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, nude, lying on bed, vibrator, sex toy, spread legs, biting lip, embarrassed, blush, panting, {bedroom}"},
        {"id": "S10b_toy_orgasm", "sub": "orgasm", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, nude, vibrator, orgasm, fucked silly, ahegao, rolling eyes, tongue out, squirting, arched back, trembling, sweat, blush, {bedroom}"},
        {"id": "S11_lactation", "sub": "lactation", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, nude, lactation, breast milk, milk dripping, large breasts, squeezing breast, embarrassed, blush, sitting on bed, {bedroom}"},
        
        # === Sex② 快楽を貪る ===
        {"id": "S12a_sex2_before", "sub": "pre_insertion", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, nude, cowgirl position, girl on top, straddling, 1boy, grabbing penis, eager, wet pussy, dripping, seductive smile, licking lips, hungry eyes, blush, {bedroom}"},
        {"id": "S12b_sex2_insert", "sub": "insertion", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, 1boy, cowgirl position, girl on top, straddling, sex, vaginal, slamming down, moaning, open mouth, pleasure, love juice, wet, blush, sweat, {bedroom}, from below"},
        {"id": "S12c_sex2_quick_orgasm", "sub": "orgasm", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, 1boy, cowgirl position, girl on top, sex, vaginal, instant orgasm, fucked silly, ahegao, rolling eyes, tongue out, squirting, female ejaculation, addicted, arched back, trembling, drooling, sweat, wet sheets, {bedroom}, from below"},
        {"id": "S12d_sex2_pos1", "sub": "sex", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, 1boy, cowgirl position, girl on top, bouncing, sex, vaginal, riding aggressively, large breasts, bouncing breasts, fucked silly, drooling, love juice, wet thighs, insatiable, craving, panting, sweat, {bedroom}, from below"},
        {"id": "S12e_sex2_pos2", "sub": "sex", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, 1boy, sitting sex, face to face, straddling lap, sex, vaginal, deep penetration, grinding, embrace, tongue out, saliva trail, kiss, sweat, love juice dripping, desperate, wanting more, {bedroom}"},
        {"id": "S12f_sex2_almost", "sub": "orgasm", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, 1boy, cowgirl position, sex, vaginal, about to orgasm, fucked silly, trembling, drooling, tongue out, cross-eyed, begging, sweat, love juice, wet everywhere, gripping shoulders, desperate, {bedroom}, from below"},
        {"id": "S12g_sex2_climax", "sub": "orgasm", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, 1boy, cowgirl position, sex, vaginal, simultaneous orgasm, fucked silly, ahegao, rolling eyes, tongue out, drooling, squirting, female ejaculation, cum, creampie, cum overflow, arched back, convulsing, sweat, wet sheets, {bedroom}"},
        {"id": "S12h_sex2_after", "sub": "afterglow", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, nude, lying on bed, after sex, cum overflow, cum dripping, cum on thighs, cum on stomach, cum on breasts, love juice, wet everywhere, fucked silly, dazed, satisfied grin, tongue out, drooling, wanting more, messy hair, sweat, ruined sheets, {bedroom}"},
        
        # === エピローグ ===
        {"id": "S13_pregnant", "sub": "pregnant", "type": "sensitive",
         "p": f"nsfw, sensitive, {CHAR}, pregnant, large belly, hand on belly, {maternity}, gentle smile, blush, standing, {bedroom}, window, morning light, curtains, warm tones"},
        {"id": "S14_pregnant_sex", "sub": "sex", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, 1boy, pregnant, large belly, sex, vaginal, from behind, gentle, careful, blush, panting, embarrassed, {bedroom}, soft shadows"},
        {"id": "S15_birth", "sub": "birth", "type": "explicit",
         "p": f"nsfw, explicit, {CHAR}, pregnant, huge belly, lying on bed, labor, spread legs, panting, sweat, flushed, determined expression, gripping sheets, {hospital}"},
        {"id": "S16_future", "sub": "standing_portrait", "type": "safe",
         "p": f"sfw, {CHAR}, mature, adult, {future_outfit}, gentle smile, holding child hand, {future_loc}"},
        
        # === おまけ ===
        {"id": "S99_bonus_swimsuit", "sub": "bonus", "type": "sensitive",
         "p": f"nsfw, sensitive, {CHAR}, {bonus_outfit}, large breasts, cleavage, wet skin, smile, looking at viewer, wind, floating hair, {bonus_loc}"},
    ]

    return [{"id": p["id"], "genre": GENRE, "type": p["type"], "subtype": p["sub"],
             "content": {"default": p["p"]}} for p in prompts]


def main():
    parser = argparse.ArgumentParser(description="Generate story prompts from character config")
    parser.add_argument("character_file", help="Character JSON config file")
    parser.add_argument("-o", "--output", required=True, help="Output prompt file")
    parser.add_argument("--base", default=DEFAULT_MODEL_GROUPS_FILE, help="Base model groups file")
    args = parser.parse_args()

    with open(args.character_file) as f:
        char_config = json.load(f)

    model_groups, negative_common = load_model_groups(args.base)
    prompts = build_story_prompts(char_config)

    total_models = sum(len(g["models"]) for g in model_groups.values())
    output = {
        "_meta": {
            "description": f"イラストノベル - {char_config['name']}",
            "created": "2026-02-16",
            "version": "prod-v1",
            "character": char_config["name"],
            "seeds": char_config.get("seeds", [42, 123, 456]),
            "total_images": f"{len(prompts)} prompts × {len(char_config.get('seeds', [42,123,456]))} seeds × {total_models} models = {len(prompts) * len(char_config.get('seeds', [42,123,456])) * total_models} images"
        },
        "negative_common": negative_common,
        "model_groups": model_groups,
        "prompts": prompts,
    }

    with open(args.output, "w") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"Generated: {args.output}")
    print(f"  Character: {char_config['name']}")
    print(f"  {len(prompts)} scenes × {len(char_config.get('seeds', [42,123,456]))} seeds × {total_models} models")


if __name__ == "__main__":
    main()
