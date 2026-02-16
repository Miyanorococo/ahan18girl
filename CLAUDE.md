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

#### バッチ評価（13モデル並列） — AWS Batch + Step Functions

EC2 Fleet + bash スクリプトの問題（UserData二重base64、ドライバ欠如、孤立EBS、手動リトライ等）を構造的に解決。**本番稼働中（2026-02-16テスト成功、13モデル並列 SUCCEEDED）。**

**アーキテクチャ**:
```
Step Functions (r18-anime-eval)
  ├─ Map State (13並列)
  │   └─ Batch SubmitJob (MODEL_NAME=XXX) ← .sync で完了待ち
  │       ├─ Spot CE (g6e.xlarge/2xlarge, g6.xlarge/2xlarge)
  │       └─ OD CE (g6e.xlarge) ← Spot不可時の自動フォールバック
  ├─ Lambda: ギャラリーindex再構築
  └─ Lambda: SNS通知
```

**Docker**: `r18-anime-eval` (ECR) — CUDA 12.4 + ComfyUI + generate-eval.py
**プロンプト**: S3から動的ダウンロード（`s3://r18-anime-assets/eval-scripts/eval-prompts.json`）
**モデルファイル**: S3から実行時にダウンロード（EFS/EBS不要、孤立リスクゼロ）
**リトライ**: Batch自動5回（Spot中断、OOM対応）+ generate-eval.pyのS3レジュームで重複なし
**ドライバ**: `ECS_AL2_NVIDIA` AMI自動選択（ドライバ問題を根絶）
**注意**: Docker再ビルド時は `onnxruntime` を追加すること（aesthetic scorer用、現在未対応）

**実行手順（プロンプト切り替え → 生成）**:
```bash
# 1. プロンプトファイルを切り替え
cp assets/templates/eval-prompts-v4-tentacle.json assets/templates/eval-prompts.json
# 2. S3にアップロード
aws s3 cp assets/templates/eval-prompts.json s3://r18-anime-assets/eval-scripts/eval-prompts.json --region us-east-1
# 3. Step Functions実行
./scripts/start-batch-eval.sh
```

**コマンド**:
```bash
# Docker build → ECR push
./scripts/build-and-push.sh

# 全13モデル実行
./scripts/start-batch-eval.sh

# 単一モデルテスト
./scripts/start-batch-eval.sh --models "dreamshaper-8"

# 進捗確認
./scripts/start-batch-eval.sh --status

# Batchログ
aws logs tail /aws/batch/r18-anime-eval --follow
```

**CloudFormation**: `aws/batch-cloudformation.yml` (スタック名: `r18-anime-batch`)
**State Machine定義**: `aws/stepfunctions.asl.json`

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
├── gallery/                    # ギャラリーフロントエンド（Alpine.js SPA）
│   ├── css/gallery.css         # 全スタイル
│   ├── js/
│   │   ├── app.js              # メインコンポーネント（ルーティング/評価/フィルタ）
│   │   ├── lightbox.js         # ライトボックス（5軸評価/♥/コメント/Save）
│   │   ├── model-grid.js       # Model Grid View（Nモデル比較）
│   │   ├── dashboard.js        # Dashboard（チャート/ヒートマップ/Insights/Export）
│   │   ├── compare.js          # 2パネル比較
│   │   ├── api.js              # APIクライアント
│   │   └── utils.js            # ユーティリティ
│   ├── index.html              # SPA エントリポイント
│   ├── experiments/            # Lambda自動展開（Zip→thumb/full/metadata.json）
│   ├── user-data/              # ratings.json (v2: 5軸スコア+コメント+♥+タグ)
│   └── ★ S3 syncは --exclude 'experiments/*' --exclude 'user-data/*' 必須
├── lambda/gallery/             # Lambda関数
│   ├── lambda_function.py      # ルーター（API Gateway + S3 Event）
│   ├── routes/
│   │   ├── experiments.py      # GET 実験一覧/詳細
│   │   ├── ratings.py          # GET/PUT 評価データ
│   │   ├── select.py           # POST コピー/削除/学習データ保存
│   │   ├── extract.py          # S3 Event → Zip展開 + Bedrock genre推定
│   │   └── productions.py      # GET 本番制作データ
│   └── services/
│       ├── genre_inference.py   # Bedrock Haiku ジャンルAI推定（フォールバック付き）
│       ├── index_builder.py     # experiment index構築
│       ├── s3_client.py         # S3操作ラッパー
│       └── thumbnail.py         # Pillowサムネイル生成
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

**Lambda再デプロイ**:
```bash
cd lambda/gallery && zip -r /tmp/lambda-gallery.zip . -x "*.pyc" "__pycache__/*"
aws lambda update-function-code --function-name r18-anime-gallery --zip-file fileb:///tmp/lambda-gallery.zip --region us-east-1
```

**ジャンルAI推定（Bedrock）**:
- Zip展開時 + ギャラリー閲覧時に自動実行
- フォールバック: Haiku 4.5 → 3.5 → 3（Anthropicのみ。NovaはNSFW拒否）
- DLSite準拠分類: 制服/人妻/触手/温泉/ランジェリー等
- コスト: ~$0.00029/回（短縮出力フォーマット）

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

## イラストノベル制作

### 制作方式（A/B/C）

**A. テンプレート量産**: 同じストーリー骨格 × キャラ差し替え。高速。
**B. モジュラー構成**: ストーリーブロックを組み合わせ。バリエーション豊富。推奨メイン。
**C. フルオリジナル**: ストーリーから毎回設計。差別化作品向け。

### 制作フロー

```
1. ユーザーがキャラ+ストーリー方針を指示
2. Claudeがプロンプトファイル（eval-prompts-prod-xxx.json）を直接生成
   - Book ID: MMDDa形式（0216a, 0216b, ...）で一意
   - Seeds: ランダム生成してJSONに書き込み（全モデル共通）
3. S3アップロード → Batch実行（7モデル並列）
4. ギャラリーBook viewで全モデル比較 → シーンごとにベスト画像選択
5. 選択画像をproductions/に保存 → テキスト配置 → 出版
```

**重要: Seedはプロンプトファイル生成時にランダム生成してJSONに書き込む。**
Batchの各ワーカーはS3からプロンプトを読むので、固定seedが全モデルで共有される。

### 使用モデル（7モデル、全モデルで生成→ベスト選択）

| モデル | 設定 | 備考 |
|--------|------|------|
| WAI v16, v12, v11, Rouwei | euler_a, sgm_uniform, cfg7, clip2, 1024×1536 | Illustrious系共通設定 |
| Animagine XL 4.0 | euler_a, normal, cfg7, clip2, 1024×1536 | **strip_tags 33個**（ライティング/アングル/skin除外） |
| Nova Anime XL | euler_a, sgm_uniform, cfg7, clip2, 1024×1536 | Illustrious系設定 |
| FeMix HassakuXL | euler_a, sgm_uniform, cfg7, clip2, 1024×1536 | Illustrious系設定 |

### プロンプト設計原則

- タグ20-25個以下（過密→破綻）
- 明るい環境（dungeon/dark禁止 → warm lighting, bedroom）
- ポジティブ/ニュートラル感情（screaming/crying禁止 → panting, blush）
- Animagineはライティング/アングル/skin指定不要（strip_tagsで自動除外）
- シーン別ライティング: school=afternoon light, fantasy=candlelight, 室内=warm lighting

### Sex①とSex②の描写差

| 要素 | Sex①（初体験） | Sex②（2回目以降） |
|------|---------------|-------------------|
| 主体 | 受け身、驚き | 自分から求める |
| 感情 | surprised, confused, embarrassed | eager, insatiable, addicted |
| 表情 | wide eyes, covering mouth | fucked silly, ahegao, drooling |
| 体位 | 正常位→バック（受け身） | 騎乗位中心（自分が動く） |
| 体液 | cum, creampie（控えめ） | squirting, cum overflow, love juice, wet everywhere |

### 表現タグリファレンス

| シーン | 推奨タグ |
|--------|---------|
| orgasm | `fucked silly, ahegao, rolling eyes, tongue out` |
| sex中 | `fucked silly` + 体位タグ |
| 射精後 | `cross-eyed, dazed` + `cum overflow` |
| 潮吹き | `squirting, female ejaculation` |
| バック | `twisted torso, looking back, from behind` |
| sensitive | `leaning forward` + `floating hair` |
| 恥じらい | `embarrassed, shy, bashful`（シーンに合わせ使い分け） |

### Book View（ギャラリー機能）

- `#/book` でBook一覧 → クリックでBook詳細（ページ送り+モデル/seed切替）
- テスト用プレフィックス（UP, P, FS, DY, SQ, CG, NR, TN, SM, R）は除外

**Book ID命名規則（ユニークID）:**
```
{MMDD}{a-z}_{シーン番号}_{シーン名}

例:
0216a_S00_cover      ← 2/16の1冊目、表紙
0216a_S08f_sex1_climax  ← 同じ本のSex①クライマックス
0216b_S00_cover      ← 2/16の2冊目（別テーマ）
0217a_S00_cover      ← 2/17の1冊目
```

- Book ID (`0216a`) が一意キー。日付+連番で自動的に被らない
- 同じテーマの2作目も `0216b`, `0217a` 等で区別
- Book viewは `0216a` でグルーピングして1冊として表示
- テーマ名はmetadata (`_meta.book_theme`) に記載

### 参照ファイル

- `characters/` — キャラ定義JSON + ストーリーブロック定義
- `assets/templates/eval-prompts-prod-*.json` — 本番プロンプトファイル
- Obsidian `29_イラストノベルJKストーリー.md` — ストーリー構成+全プロンプト
- Obsidian `31_イラストノベル量産方針.md` — A/B/C方式詳細

## コスト

### 月間コスト（AWS、us-east-1）

**常時稼働リソース（EC2停止中も課金）:**
| 項目 | コスト | 備考 |
|---|---|---|
| NAT Gateway | ~¥4,800 ($32) | CFnスタック内。Private Subnet → Internet |
| ALB | ~¥2,700 ($18) | CFnスタック内。CloudFront → ComfyUI |
| VPC Interface Endpoints (SSM×3) | ~¥3,300 ($22) | CFnスタック内。SSMセッション用 |
| EBS 200GB gp3（暗号化） | ~¥2,400 ($16) | データボリューム |
| **常時稼働小計** | **~¥13,200/月** | EC2不使用月でもかかる |

**EC2使用時の追加コスト:**
| 項目 | コスト |
|---|---|
| EC2 g6e.xlarge スポット（月150h × $0.82） | ~¥18,500 |
| S3 Intelligent-Tiering（50GB） | ~¥200 |
| データ転送 | ~¥100 |
| **EC2使用時の合計** | **~¥32,000/月** |

※ g6eスポット不安定時にg5.xlargeフォールバック（$0.37/h）で月~¥22,000に下がる
※ オンデマンド利用時は最大~¥45,000/月
※ NAT Gateway削減策: EC2不使用時にCFnスタックをdelete→使用時にre-createで常時稼働コスト削減可

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

## 前回セッション要約（2026-02-16）

### 主な成果
- ギャラリー全面改修（4段階評価、カルーセルLB、クロスモデルGrid、AIスコア表示）
- AI自動スコアリング実装（anime-aesthetic ONNX、Lambda 3GB、全件完了）
- **AI score ≠ 人間評価（逆相関）** → AIは破綻フィルターとしてのみ使用
- プロンプト全面レビュー（122件、設計3原則確立、fucked_silly/dynamic/恥じらい追加）
- **7モデル確定**: Animagine, Nova, Rouwei, v16, v12, v11, FeMix
- **FeMix設定修正**: euler_a/sgm_uniform/clip2/1024×1536に統一（旧設定で破綻していた）
- Animagine strip_tags: 33タグ除外（ライティング/アングル/skin不要）
- テスト実験: fucked_silly, dynamic, squirting, cowgirl → 結果レビュー済み
- **本番JK制作開始**: 34シーン × 3seed × 7モデル = 714枚 Batch実行
- 量産方式確立: A(テンプレート)/B(モジュラー)/C(オリジナル)
- ストーリーブロック定義 + キャラ定義JSON（JK/人妻/エルフ）

### 進行中タスク
- prod-jk v2 Batch（714枚生成中）
- prod-jk v3（Sex①②修正版）→ v2完了後に自動起動

### 詳細ログ
- Obsidian: `28_セッションログ_20260216.md`（全実施内容）
- Obsidian: `29_イラストノベルJKストーリー.md`（ストーリー+プロンプト）
- Obsidian: `31_イラストノベル量産方針.md`（A/B/C方式）
