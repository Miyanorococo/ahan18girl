# r18_anime - AI生成アダルトコンテンツ制作プロジェクト

## プロジェクト概要

AI画像生成を活用したアダルトコンテンツの制作・販売プロジェクト。
月収30万円の達成を目標とする。

## 決定事項

- **戦略**: アニメ系（戦略A）から開始 → 軌道に乗ったらフォトリアル系（戦略B）を追加
- **インフラ**: AWS EC2（g6e.xlarge スポット、L40S 48GB、us-east-1）
- **メインモデル**: WAI-NSFW-illustrious v16（DL数113万、NSFW特化、商用画像生成OK）
- **販売チャネル**: FANZA（メイン）+ DLSite（ゲーム/ノベル形式）+ Fantia（サブスク）

## 技術スタック

### モデル
| 用途 | モデル | ライセンス |
|---|---|---|
| 本編CG（NSFW） | WAI-NSFW-illustrious v16 | FAIPL-1.0-SD（商用画像生成OK） |
| 表紙/全年齢 | Animagine XL 4.0 v4 Opt | CreativeML Open RAIL++-M（商用可） |
| 構図ガチャ | Z-Image Turbo | Apache 2.0 |
| タイトル文字 | Qwen-Image-2512 | Apache 2.0 |
| 動画化（Phase 3〜） | Wan 2.6 | - |
| リアル系（戦略B） | getphat FLUX Reality v11 | 画像販売可（モデル自体は非商用） |

### ツール
- ComfyUI（メインUI）
- ControlNet（ポーズ指定）
- ADetailer（顔・手修正）
- IP-Adapter / PuLID（キャラ一貫性）
- SUPIR + 4x Foolhardy Remacri（アップスケール）

### AWS構成

#### リージョン
us-east-1（バージニア）。GPUスポット価格が最安。

#### コンピュート
| モード | インスタンス | GPU | VRAM | Spot実績 | 用途 |
|---|---|---|---|---|---|
| 通常（デフォルト） | g6e.xlarge スポット | L40S | 48GB | ~$0.82/h（¥123） | 通常の制作作業 |
| フォールバック | g5.xlarge スポット | A10G | 24GB | ~$0.37/h（¥56） | g6eスポット不安定時 |
| 安定モード | g6e.xlarge オンデマンド | L40S | 48GB | $1.53/h（¥230） | スポット不安定時 |

- `start-spot.sh` でg6e.xlarge起動。`--fallback g5` でg5にフォールバック
- `--on-demand` フラグでオンデマンドに切替可能
- スポット中断検知 → 自動S3同期（`spot-monitor.sh`）
- 推奨AZ: us-east-1c または us-east-1d（スポット価格が安定して安い）
- SDXL生成速度: ~5-10秒/枚（1024x1536、g6e）

**g6e.xlarge選定理由**:
- L40S 48GBでフルパイプライン（ControlNet + ADetailer + IP-Adapter + SUPIR）が余裕で同時ロード
- FP16 362 TFLOPSでSDXL生成が~5-10秒/枚（A10Gの約3倍速）
- 1枚あたりコストはg5より安い（$0.82/hでも生産性3倍）

**不採用: Trainium / Inferentia**
ComfyUIおよびカスタムノード群（ControlNet, ADetailer, IP-Adapter, PuLID, SUPIR）がすべてCUDA専用。Neuron SDK対応なし。バッチ量産フェーズで再評価。

#### ストレージ
| リソース | 用途 | 備考 |
|---|---|---|
| EBS 200GB gp3（暗号化有効） | 作業用（モデル + 生成中の画像） | インスタンス停止中も課金継続 |
| S3 | 永続保存（モデル、完成画像、ログ） | Intelligent-Tiering、¥3/GB/月〜 |

**ストレージ運用フロー**:
1. 生成中: ComfyUI → EBS `output/` に書き出し（高速I/O）
2. 作業終了時: `sync-output.sh` で EBS `output/` → S3 に同期
3. スポット中断検知時: 自動で `sync-output.sh` 実行
4. モデルファイル: S3に永続保存、EC2起動時にEBSへ同期

**S3バケット**: `r18-anime-assets`

**S3構造**:
```
s3://r18-anime-assets/
├── models/                     # モデルファイル永続保存
│   ├── checkpoints/
│   ├── loras/
│   ├── controlnet/
│   └── upscalers/
├── experiments/                # モデル試行・パイプライン検証（Zip単位）
│   └── {YYYYMMDD}_{model}/
│       └── {YYYYMMDD}_{model}_{pipeline}_{prompt}_{params}_seed{N}x{count}.zip
├── productions/                # 本番制作（作品単位）
│   └── {work-id}_{作品名}/
│       ├── raw/                # 全生成画像（大量ガチャ結果）
│       ├── selected/           # 選別済み（採用候補）
│       ├── final/              # 最終版（ポストプロセス済み）
│       └── metadata/           # 生成ログ、品質レポート
├── output/                     # ComfyUI直接出力（sync-output.sh用）
├── logs/                       # 生成ログ（証拠保全）
├── workflows/                  # ワークフローバックアップ
├── references/                 # 参照画像（ControlNet入力、顔参照等）
│   ├── poses/
│   ├── faces/
│   └── styles/
├── ami-configs/                # AMI再構築用設定
├── gallery/                    # ギャラリーフロントエンド + Lambda展開データ
│   ├── css/                    # スタイルシート
│   ├── js/                     # Alpine.js + mixins
│   ├── index.html              # SPA エントリポイント
│   ├── experiments/            # Lambda自動展開（Zip→thumb/full/metadata.json）
│   ├── user-data/              # ratings.json (評価データ)
│   └── ★ gallery/のS3 syncは --exclude 'experiments/*' --exclude 'user-data/*' 必須
└── training-data/              # ♥ Save で保存した学習データ
    ├── {model}/{label}/        # ラベル別画像
    └── labels.json             # メタデータ
```

**ギャラリーデプロイ（フロントエンドのみ）**:
```bash
aws s3 sync gallery/ s3://r18-anime-assets/gallery/ \
  --exclude 'experiments/*' --exclude 'user-data/*'
```
⚠️ `--delete` を使うとLambdaが展開した実験データ・評価データが消える。絶対に使わない。

**実験Zip命名規則**:
```
{YYYYMMDD}_{model}_{pipeline}_{prompt要約}_{params}_seed{start}x{count}.zip

例:
20260216_wai-nsfw-v16_txt2img_blonde-school_steps30-cfg7-euler-a_seed42x10.zip
20260216_p2_fluxS-waiV16_beach-bikini_cn-pose08-depth06-ipa07_seed100x10.zip
```

各Zip内に `metadata.json`（モデル名、プロンプト全文、パラメータ、シード一覧）を同梱し、DLSite生成ログ提出にも対応。
`scripts/batch-experiment.sh` で生成→Zip→S3アップロードを自動化。

#### セキュリティ
- AMI: Deep Learning AMI（Ubuntu）
- アクセス: SSHトンネル経由でComfyUI WebUI（ポート8188は外部非公開）
- セキュリティグループ: SSH(22)のみ、ソースIPを自宅IPに限定
- EC2にIAMインスタンスプロファイル付与（アクセスキーをEC2に置かない）
- S3: パブリックアクセス完全ブロック
- EBS: 暗号化有効

#### SageMaker / Inferentia（将来検討）
Phase 2後半以降、ワークフローが固まりAPIバッチ量産する段階でSageMaker Batch TransformまたはInferentia2を検討。
現時点ではComfyUI WebUIでのインタラクティブ操作が必須のためEC2を採用。

## ディレクトリ構造（予定）

```
r18_anime/
├── CLAUDE.md                  # このファイル
├── README.md                  # プロジェクト概要
├── aws/
│   ├── setup.sh               # EC2初期セットアップスクリプト
│   ├── start-spot.sh          # スポットインスタンス起動（--on-demand対応）
│   ├── stop-instance.sh       # インスタンス停止
│   ├── sync-models.sh         # S3 ↔ EBSモデル同期
│   ├── sync-output.sh         # EBS output → S3同期
│   ├── spot-monitor.sh        # スポット中断検知 → 自動同期
│   └── cloudformation.yml     # インフラ定義（VPC, SG, IAMロール, EBS）
├── comfyui/
│   ├── workflows/             # ComfyUIワークフロー(.json)
│   │   ├── anime-cg-base.json
│   │   ├── upscale-8k.json
│   │   └── character-consistency.json
│   └── configs/               # モデル・LoRA設定
├── assets/
│   ├── characters/            # キャラクター設定・LoRA
│   └── templates/             # プロンプトテンプレート
├── output/                    # 生成画像（.gitignore対象）
├── logs/                      # 生成ログ（プロンプト、設定等の記録）
└── docs/                      # 制作ノート・市場分析メモ
```

## 制作ルール

### ライセンス遵守
- 商用禁止モデル（NoobAI, FLUX.1 dev本体, Hunyuan 3.0等）は使用しない
- FLUX.1 dev派生（getphat等）は「画像販売OK」だが「モデル再配布NG」
- 生成ログ（モデル名、LoRA、プロンプト、シード）を全て記録・保存する

### コンテンツ安全
- 特定作家・キャラクターの模倣LoRAは使用しない（自作オリジナルLoRAのみ）
- 18歳未満に見える人物の性的表現は絶対に行わない
- 実在人物の性的画像は生成しない
- AI生成であることを各プラットフォームで正直に申告する

### 品質基準
- 手・指の破綻チェック → ADetailerで自動修正 + 目視確認
- 最低解像度: 1024x1536（SDXLネイティブ）→ SUPIRで2倍以上にアップスケール
- 1作品あたり最低20枚（サンプル5枚 + 本編15枚以上）

## コスト

### 月間固定費（AWS、us-east-1）
| 項目 | コスト |
|---|---|
| EC2 g6e.xlarge スポット（月150h × $0.82） | ~¥18,500 |
| EBS 200GB gp3（暗号化） | ~¥2,400 |
| S3 Intelligent-Tiering（50GB） | ~¥200 |
| データ転送 | ~¥100 |
| **合計** | **~¥21,000/月** |

※ g6eスポット不安定時にg5.xlargeフォールバック（$0.37/h）で月¥13,000程度に下がる
※ オンデマンド利用時は最大~¥35,000/月

### 収益目標
- Phase 1（1-2ヶ月）: テスト期間。月収¥0〜¥30,000
- Phase 2（3-4ヶ月）: 量産開始。月収¥50,000〜¥100,000
- Phase 3（5-6ヶ月）: 最適化。月収¥150,000〜¥200,000
- Phase 4（7ヶ月〜）: 目標達成圏。月収¥250,000〜¥350,000

## 詳細戦略ドキュメント

Obsidian: `/Users/rkuros/Obsidian/AWS/AWS/AI出版戦略/` に以下のファイルが存在:
- 00_戦略サマリー.md
- 01_市場分析.md
- 02_モデル・ツール選定.md（AWS構成、40+モデル比較含む）
- 03_制作ワークフロー.md
- 04_販売チャネル戦略.md
- 05_収益シミュレーション.md
- 06_リスクと対策.md
- 07_アクションプラン.md
- 08_追加収益化アイデア.md
- 09_モデル詳細調査（2026年2月）.md
