# ahan18girl

AI画像生成を活用したアダルトアニメコンテンツの制作・販売プロジェクト。

## アーキテクチャ

```
┌─────────────┐     SSH Tunnel      ┌──────────────────────────────────┐
│  Local Mac   │◄──────────────────►│  AWS EC2 (g6e.xlarge Spot)       │
│              │   localhost:8188    │  ┌────────────────────────────┐  │
│  ブラウザで   │                     │  │ ComfyUI (127.0.0.1:8188)  │  │
│  ComfyUI操作 │                     │  │  + ControlNet              │  │
│              │                     │  │  + Impact Pack (ADetailer) │  │
└─────────────┘                     │  │  + IP-Adapter / PuLID      │  │
                                    │  │  + UltimateSDUpscale       │  │
                                    │  └────────────────────────────┘  │
                                    │                                  │
                                    │  EBS 200GB (暗号化)              │
                                    │  /data/ComfyUI/models/           │
                                    │  /data/ComfyUI/output/           │
                                    └──────────┬───────────────────────┘
                                               │ aws s3 sync
                                    ┌──────────▼───────────────────────┐
                                    │  S3 (Intelligent-Tiering)        │
                                    │  models/ output/ logs/ workflows/│
                                    └──────────────────────────────────┘
```

## セットアップ

### 1. 環境変数の設定

```bash
cp .env.example .env
# .env を編集: AWS_PROFILE, KEY_PAIR_NAME, MY_IP 等を記入
```

### 2. AWSインフラ構築

```bash
# CloudFormationスタックのデプロイ
./aws/deploy-stack.sh

# スタック出力が自動で .env に書き込まれる
# (LAUNCH_TEMPLATE_ID, SUBNET_ID, SG_ID, EBS_VOLUME_ID)
```

### 3. EC2起動 & 初期セットアップ

```bash
# Spotインスタンス起動
./aws/start-spot.sh

# SSH接続 (ComfyUIトンネル付き)
./aws/connect.sh

# EC2上で初期セットアップ実行
sudo bash /path/to/setup.sh

# モデルダウンロード (EC2上で)
bash /path/to/scripts/download-models.sh
```

### 4. 制作開始

ブラウザで http://localhost:8188 を開く。

## 日常の使い方

```bash
# --- 作業開始 ---
./aws/start-spot.sh              # GPU起動 + SSHトンネル
# → ブラウザで http://localhost:8188

# --- 作業終了 ---
./aws/sync-output.sh             # 生成画像をS3にバックアップ
./aws/stop-instance.sh           # インスタンス停止

# --- その他 ---
./aws/start-spot.sh --fallback g5   # g5.xlargeで起動 (Spot不安定時)
./aws/start-spot.sh --on-demand     # オンデマンドで起動 (緊急時)
./aws/connect.sh --tunnel-only      # トンネルだけ張る
./aws/connect.sh --ip               # インスタンスIPを表示
./aws/sync-models.sh --upload       # LoRA等をS3にバックアップ
./aws/sync-output.sh --dry-run      # 同期プレビュー
```

## プロジェクト構成

```
├── aws/
│   ├── cloudformation.yml     # インフラ定義 (VPC, SG, IAM, EBS, S3)
│   ├── deploy-stack.sh        # CFnデプロイ/削除
│   ├── setup.sh               # EC2初期セットアップ (ComfyUI + ノード)
│   ├── start-spot.sh          # Spotインスタンス起動
│   ├── stop-instance.sh       # インスタンス停止/終了
│   ├── spot-monitor.sh        # Spot中断検知デーモン
│   ├── sync-models.sh         # モデルファイル S3↔EBS 同期
│   ├── sync-output.sh         # 生成画像・ログ → S3 同期
│   └── connect.sh             # SSH接続ヘルパー
├── comfyui/
│   ├── workflows/
│   │   ├── anime-cg-base.json          # 基本アニメCG生成
│   │   ├── upscale-8k.json             # 高解像度アップスケール
│   │   └── character-consistency.json   # IP-Adapterキャラ統一
│   └── configs/
│       └── models.yml                   # モデル定義 (URL, ライセンス)
├── assets/
│   ├── templates/
│   │   ├── prompts.yml            # Danbooruタグ形式テンプレート
│   │   └── generation-log.yml     # 生成ログフォーマット
│   └── characters/
│       └── template.yml           # キャラクター定義テンプレート
├── scripts/
│   └── download-models.sh         # モデル一括ダウンロード
├── output/                        # 生成画像 (.gitignore)
├── logs/                          # 生成ログ
└── docs/                          # 制作ノート
```

## モデル

| 用途 | モデル | ライセンス |
|------|--------|-----------|
| 本編CG (NSFW) | WAI-NSFW-illustrious v16 | FAIPL-1.0-SD (商用画像生成OK) |
| 表紙/全年齢 | Animagine XL 4.0 v4 Opt | CreativeML Open RAIL++-M |
| 構図ガチャ | Z-Image Turbo | Apache 2.0 |
| アップスケール | 4x Foolhardy Remacri | 商用利用可 |

## ComfyUIワークフロー

### anime-cg-base
基本的なアニメCG生成フロー。WAI v16 → ControlNet (ポーズ) → FaceDetailer (顔修正) → 保存。
- 解像度: 1024x1536
- サンプラー: euler_ancestral / 25 steps / CFG 7.0

### upscale-8k
高解像度化フロー。4x Foolhardy Remacri → KSampler refinement (denoise 0.3)。

### character-consistency
IP-Adapter (weight 0.8) でリファレンス画像からキャラクターの一貫性を維持。

## コスト

| 項目 | 月額 |
|------|------|
| EC2 g6e.xlarge Spot (150h) | ~¥18,500 |
| EBS 200GB gp3 | ~¥2,400 |
| S3 Intelligent-Tiering | ~¥200 |
| データ転送 | ~¥100 |
| **合計** | **~¥21,000** |

## ライセンス・制作ルール

- 商用禁止モデルは使用しない
- 生成ログ (モデル, プロンプト, シード等) を全て記録・保存
- 特定作家・キャラクターの模倣LoRAは不使用
- AI生成であることを販売プラットフォームで申告
