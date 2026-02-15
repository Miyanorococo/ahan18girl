# ahan18girl

AI画像生成を活用したアダルトアニメコンテンツの制作・販売プロジェクト。

## システム構成図

```
                                    ┌──────────────────────────────────┐
                                    │          CloudFront              │
                                    │      (Basic Auth + OAC)          │
                                    └──┬────────────┬────────────┬─────┘
                                       │            │            │
                              /gallery/*     /api/*          /*
                                       │            │            │
                               ┌───────▼──┐  ┌─────▼──────┐  ┌──▼──────────┐
                               │  S3      │  │ API GW     │  │   ALB       │
                               │  Static  │  │ (HTTP)     │  │ (ComfyUI)   │
                               └───────┬──┘  └─────┬──────┘  └──┬──────────┘
                                       │            │            │
                                       │     ┌──────▼──────┐    │
                                       │     │   Lambda     │    │
                                       │     │ (Python 3.12)│    │
┌──────────────────────────────────────┐│     │             │    │
│  S3: r18-anime-assets               ││     │ - experiments│    │
│                                      │◄─────│ - ratings    │    │
│  gallery/                            │      │ - select     │    │
│    ├── index.html, js/, css/         │      │ - infer-genre│    │
│    ├── experiments/{id}/             │      │ - extract    │    │
│    │     ├── full/*.png              │      └──────┬───────┘    │
│    │     ├── thumb/*.webp            │             │            │
│    │     └── metadata.json           │       Bedrock            │
│    ├── user-data/ratings.json        │       Haiku 4.5/3.5/3   │
│    └── index.json                    │       (Genre AI推定)     │
│                                      │                          │
│  experiments/                        │──── S3 Event ──► Lambda  │
│    └── {date}_{model}/*.zip          │     (Zip→展開+サムネ生成) │
│                                      │                          │
│  eval-scripts/                       │                          │
│    ├── generate-eval.py              │                          │
│    └── eval-prompts.json             │                   ┌──────▼─────────────┐
│                                      │                   │  EC2 (Private SN)  │
│  training-data/{model}/{label}/      │                   │  g6e.xlarge Spot   │
│  models/checkpoints/                 │                   │  (L40S 48GB)       │
│  productions/                        │                   │                    │
└──────────────────────────────────────┘                   │  ComfyUI :8188     │
                                                           │  13 SDXLモデル     │
         ┌─────────────────────────────┐                   │  ControlNet        │
         │  並列評価ワーカー            │                   │  IP-Adapter/PuLID  │
         │  EC2 Fleet (Spot)           │                   └────────┬───────────┘
         │  g5/g6e.xlarge × N台        │                            │ sync
         │  UserData自動実行           │────── results ─────► S3 experiments/
         │  → 終了後自己terminate      │
         └─────────────────────────────┘
```

### データフロー

```
[制作フロー]
  ComfyUI生成 → EBS output/ → sync-output.sh → S3 output/

[モデル評価フロー]
  eval-prompts.json (110プロンプト × 13モデル)
    → parallel-eval.sh (EC2 Fleet Spot並列)
    → S3 experiments/*.zip
    → Lambda自動展開 → gallery/experiments/ (サムネ + メタデータ + AI genre推定)
    → ギャラリーSPA で♥評価 → Dashboard集計 → モデル選定

[学習データフロー]
  ギャラリー♥/Labels → POST /api/select → S3 training-data/{model}/{label}/
```

## ギャラリー評価システム

URL: CloudFront `/gallery/index.html` (Basic Auth)

Alpine.js SPA。13モデル × 複数プロンプトの生成画像を評価・比較するためのシステム。

| 機能 | 説明 |
|------|------|
| Experiments | 実験一覧 (フィルタ/ソート/ページネーション/♥ホバーボタン) |
| Lightbox | フルスクリーン評価 (5軸★/♥/コメント/Labels/キーボード操作) |
| Model Grid | N個モデル横並び比較 (同seed/同promptでモデル間ナビ) |
| Dashboard | KPI/レーダーチャート/ヒートマップ/Insights/Export |
| Knowledge Base | ジャンル×モデル推薦/マトリクス/プロンプトランキング |
| Compare | 2パネル比較 |
| Blind Mode | モデル名マスクでバイアス排除 |
| AI Genre | Bedrock Haiku自動ジャンル推定 (DLSite準拠分類) |

## セットアップ

### 1. 環境変数

```bash
cp .env.example .env
# AWS_PROFILE, MY_IP, BASIC_AUTH_USER/PASS 等を記入
```

### 2. AWSインフラ

```bash
./aws/deploy-stack.sh          # CloudFormation (VPC, SG, IAM, EBS, ALB)
./aws/deploy-gallery.sh        # Lambda + API GW + CloudFront + S3フロントエンド
```

### 3. 日常操作

```bash
./aws/start-spot.sh            # GPU起動 + ALBターゲット登録
./aws/connect.sh               # SSMセッション接続
./aws/stop-instance.sh         # インスタンス停止

./aws/sync-output.sh           # 生成画像 → S3バックアップ
```

### 4. モデル評価

```bash
./scripts/parallel-eval.sh                         # 並列生成 (EC2 Fleet)
./scripts/parallel-eval.sh --status                # 進捗確認
python3 scripts/generate-eval.py --rebuild-index   # ギャラリーindex再構築
./scripts/parallel-eval.sh --cleanup               # リソース削除
```

## プロジェクト構成

```
r18_anime/
├── aws/
│   ├── cloudformation.yml     # インフラ (VPC, SG, IAM, EBS, S3)
│   ├── cloudfront.yml         # CloudFront + Basic Auth
│   ├── gallery-stack.yml      # Lambda + API Gateway
│   ├── deploy-stack.sh        # CFnデプロイ
│   ├── deploy-gallery.sh      # ギャラリー一括デプロイ
│   ├── start-spot.sh          # Spot起動 (g6e優先, g5フォールバック)
│   ├── stop-instance.sh       # インスタンス停止
│   ├── connect.sh             # SSM接続
│   ├── spot-monitor.sh        # Spot中断検知デーモン
│   ├── sync-models.sh         # モデル S3↔EBS同期
│   └── sync-output.sh         # 生成画像 → S3同期
├── gallery/                   # フロントエンド (Alpine.js SPA)
│   ├── index.html
│   ├── css/gallery.css
│   └── js/
│       ├── app.js             # メイン (ルーティング/評価/フィルタ)
│       ├── dashboard.js       # Dashboard (チャート/ヒートマップ/Export)
│       ├── lightbox.js        # ライトボックス (5軸評価/♥/Labels)
│       ├── model-grid.js      # Model Grid (N個モデル横並び比較)
│       ├── knowledge-base.js  # KB (推薦/マトリクス/プロンプト)
│       ├── compare.js         # 2パネル比較
│       ├── api.js             # APIクライアント
│       └── utils.js           # ユーティリティ
├── lambda/gallery/            # Lambda関数
│   ├── lambda_function.py     # ルーター
│   ├── routes/
│   │   ├── experiments.py     # GET 実験一覧/詳細
│   │   ├── ratings.py         # GET/PUT 評価データ
│   │   ├── select.py          # POST 選択/削除/学習データ保存
│   │   ├── extract.py         # S3 Event Zip展開 + genre推定
│   │   └── productions.py     # GET 本番データ
│   └── services/
│       ├── genre_inference.py # Bedrock Haiku ジャンルAI推定
│       ├── index_builder.py   # index.json構築
│       ├── s3_client.py       # S3操作
│       └── thumbnail.py       # サムネイル生成
├── scripts/
│   ├── generate-eval.py       # バッチ生成 + index再構築
│   ├── parallel-eval.sh       # EC2 Fleet並列生成
│   └── download-models.sh     # モデルDL
├── assets/templates/
│   └── eval-prompts.json      # 110プロンプト × 7モデルグループ
├── comfyui/workflows/         # ComfyUIワークフロー
└── CLAUDE.md                  # プロジェクト詳細設定
```

## 評価対象モデル (13個)

| # | モデル | ベース | 商用 |
|---|--------|--------|------|
| 1 | WAI-NSFW-illustrious v16 | Illustrious | 画像生成可 |
| 2 | WAI-NSFW-illustrious v14 | Illustrious | 画像生成可 |
| 3 | WAI-NSFW-illustrious v12 | Illustrious | 画像生成可 |
| 4 | WAI-NSFW-illustrious v11 | Illustrious | 画像生成可 |
| 5 | WAI-Branch-Rouwei | Illustrious | 画像生成可 |
| 6 | Illustrij v20 | Illustrious | 全許可 (Sell含む) |
| 7 | Nova Anime XL (IL版) | Illustrious+NoobAI | 画像/Rent可 |
| 8 | AutismMix SDXL (Pony) | Pony/SDXL | 画像生成可 |
| 9 | Animagine XL 4.0 | SDXL 1.0 | 全許可 |
| 10 | Pony Diffusion V6 XL | SDXL | 要個別許諾 |
| 11 | FeMix_HassakuXL | Illustrious | 全許可 (Sell含む) |
| 12 | DreamShaper 8 | SD 1.5 | 画像生成可 |
| 13 | AAM AnyLoRA Anime Mix | SD 1.5 | 可 |

## コスト (月額)

| 項目 | コスト |
|------|--------|
| EC2 g6e.xlarge Spot (150h) | ~¥18,500 |
| 常時稼働 (EBS+NAT+ALB+VPC EP) | ~¥13,200 |
| S3 + データ転送 | ~¥300 |
| Lambda + API GW + Bedrock | ~¥200 |
| **合計 (EC2使用月)** | **~¥32,200** |
| **合計 (EC2不使用月)** | **~¥13,400** |
