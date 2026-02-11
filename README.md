# ahan18girl

AI画像生成を活用したアダルトアニメコンテンツの制作・販売プロジェクト。

## アーキテクチャ

```
┌─────────────┐      HTTPS        ┌──────────────┐     HTTP      ┌────────────┐
│  ブラウザ    │ ──────────────► │  CloudFront   │ ──────────► │    ALB      │
│              │                  │  + WAF        │              │ (Public     │
│              │                  │  (IP制限)     │              │  Subnet)    │
└─────────────┘                  └──────────────┘              └─────┬──────┘
                                                                     │ :8188
┌─────────────┐   SSM Session    ┌──────────────────────────────────▼──────┐
│  ターミナル  │ ──────────────► │  EC2 g6e.xlarge (Private Subnet)        │
│  管理操作    │                  │  ┌──────────────────────────────────┐  │
└─────────────┘                  │  │ ComfyUI (0.0.0.0:8188)          │  │
                                 │  │  + ControlNet + Impact Pack      │  │
                                 │  │  + IP-Adapter / PuLID            │  │
                                 │  └──────────────────────────────────┘  │
                                 │  EBS 200GB (暗号化) + NAT Gateway      │
                                 └────────────────┬───────────────────────┘
                                                  │ aws s3 sync
                                 ┌────────────────▼───────────────────────┐
                                 │  S3 (Intelligent-Tiering)              │
                                 └────────────────────────────────────────┘
```

## セットアップ

### 1. 環境変数の設定

```bash
cp .env.example .env
# .env を編集: AWS_PROFILE, MY_IP 等を記入
```

### 2. AWSインフラ構築

```bash
# CloudFormationスタックのデプロイ
./aws/deploy-stack.sh

# スタック出力が自動で .env に書き込まれる
# (LAUNCH_TEMPLATE_ID, SUBNET_ID, SG_ID, EBS_VOLUME_ID, CLOUDFRONT_URL, TARGET_GROUP_ARN, PRIVATE_SUBNET_ID)
# CloudFront URLもここで出力される
```

### 3. EC2起動

```bash
# Spotインスタンス起動 + ALBターゲット登録
./aws/start-spot.sh
```

### 4. 管理操作

```bash
# SSMセッション接続
./aws/connect.sh
```

### 5. 制作開始

.env の CLOUDFRONT_URL をブラウザで開く。

## 日常の使い方

```bash
# --- 作業開始 ---
./aws/start-spot.sh              # GPU起動 + ALBターゲット登録
# → .envのCLOUDFRONT_URLをブラウザで開く

# --- 管理操作 ---
./aws/connect.sh                 # SSMセッション接続
./aws/connect.sh --url           # CloudFront URLを表示

# --- 作業終了 ---
./aws/sync-output.sh             # 生成画像をS3にバックアップ
./aws/stop-instance.sh           # インスタンス停止
```

## プロジェクト構成

```
├── aws/
│   ├── cloudformation.yml     # インフラ定義 (VPC, SG, IAM, EBS, S3, CloudFront, ALB, WAF)
│   ├── deploy-stack.sh        # CFnデプロイ/削除
│   ├── setup.sh               # EC2初期セットアップ (ComfyUI + ノード)
│   ├── start-spot.sh          # Spotインスタンス起動
│   ├── stop-instance.sh       # インスタンス停止/終了
│   ├── spot-monitor.sh        # Spot中断検知デーモン
│   ├── sync-models.sh         # モデルファイル S3↔EBS 同期
│   ├── sync-output.sh         # 生成画像・ログ → S3 同期
│   └── connect.sh             # SSM接続ヘルパー
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
| NAT Gateway | ~¥4,800 |
| ALB | ~¥2,400 |
| WAF | ~¥750 |
| VPC Endpoints | ~¥3,300 |
| S3 Intelligent-Tiering | ~¥200 |
| データ転送 | ~¥100 |
| **合計** | **~¥32,000** |

## ライセンス・制作ルール

- 商用禁止モデルは使用しない
- 生成ログ (モデル, プロンプト, シード等) を全て記録・保存
- 特定作家・キャラクターの模倣LoRAは不使用
- AI生成であることを販売プラットフォームで申告
