# Gallery - AI画像評価システム

実験画像のブラウズ・評価・モデル比較・学習データキュレーションのためのWebギャラリー。

**URL**: `https://d2m524k99quzzr.cloudfront.net/gallery/index.html`

## 機能一覧

### Experiments (`#/experiments`)
- 全実験の一覧表示（カードグリッド）
- モデル・パイプライン・テキストでフィルタリング
- クリックで実験詳細 → 画像グリッド + メタデータサイドバー
- 画像ホバーで★評価（overall）+ チェックボックス選択

### Model Grid (`#/model-grid`)
- 同一プロンプトを複数モデルで生成した結果を横並び比較
- 自動グループ化: `prompt_summary` が一致する実験を検出
- シード選択バー: 同じシードの画像を各モデルで比較
- Single Seed / All Seeds ビュー切替
- 各カードにスコア・コメント・モデル判定を表示

### Dashboard (`#/dashboard`)
- モデル別スコア集計（レーダーチャート + 棒グラフ）
- ランキングテーブル（5軸スコア + 平均 + 判定）
- モデルコメント記録
- Markdown / JSON エクスポート（Claude連携用）

### Compare (`#/compare`)
- 2つの実験を詳細に並列比較
- スクロール同期
- ライトボックスからの評価可

### Blind Mode
- ナビバー右の「Blind」ボタンでON/OFF
- モデル名を「Model A」「Model B」...にマスク
- グリッドの順序もシャッフル
- 「Reveal」で正体表示

### 5軸評価（ライトボックス内）
画像をクリック → ライトボックスで以下を評価:
- **画質**: 描画品質・ノイズ
- **忠実度**: プロンプトへの忠実さ
- **人体**: 手指・顔・体の破綻度
- **NSFW**: NSFW表現の品質
- **総合**: 総合的な印象

+ テキストコメント（自動保存、1.5秒デバウンス）

### ♥ Save（学習データ保存）
ライトボックス内の「♥ Save」ボタンで:
1. ラベル選択（best-quality, face-reference, style-reference 等）
2. カスタムラベル追加可
3. S3 `training-data/{model}/{label}/` にコピー保存
4. `training-data/labels.json` にメタデータ記録

## 技術構成

| コンポーネント | 技術 |
|---|---|
| フロントエンド | Alpine.js 3 + Chart.js 4 |
| スタイル | CSS Variables (ダークテーマ) |
| バックエンド | AWS Lambda (Python) |
| データストア | S3 (`gallery/user-data/ratings.json`) |
| CDN | CloudFront |

### ファイル構成
```
gallery/
├── index.html          # SPA エントリポイント
├── css/gallery.css     # 全スタイル（ダークテーマ）
└── js/
    ├── app.js          # メインAlpine.jsコンポーネント（ルーティング、評価、ブラインドモード）
    ├── lightbox.js     # ライトボックス（5軸評価 + コメント + Save）
    ├── model-grid.js   # Model Grid View（Nモデル比較）
    ├── dashboard.js    # Dashboard（Chart.js + エクスポート）
    ├── compare.js      # 2パネル比較
    ├── api.js          # APIクライアント
    └── utils.js        # ユーティリティ

lambda/gallery/
├── lambda_function.py  # APIルーター
├── routes/
│   ├── experiments.py  # GET /api/experiments
│   ├── ratings.py      # GET/PUT /api/ratings
│   ├── select.py       # POST /api/select（production + training-data保存）
│   ├── productions.py  # GET /api/productions
│   └── extract.py      # S3イベント: Zip展開 + サムネイル生成
└── services/
    ├── s3_client.py    # S3操作
    └── index_builder.py # 実験インデックス管理
```

### Book View (`#/book`)

1冊のBook（= 1つのバッチジョブ）をページ送り＋モデル/seed切替で閲覧・編集する機能。

- **View モード**: ページ送り + モデルタブ + seed行 + プロンプト表示
- **Editor モード**: Candidateグリッドからベスト画像を選択 → PDF/ZIP出力
- **Timeline**: ページ順序のドラッグ並替え、Shelfへの退避
- **Regen**: プロンプト編集 → Flag → Lambda → Step Functions で再生成
- **Save**: エディタ状態（選択・ページ順・Shelf・Regenフラグ）をS3に永続化

#### 実験ファイルの命名規則（プレフィックス体系）

```
{bookId}[_R{n}]_{scene}[_{variant}]
```

| パート | 説明 | 例 |
|--------|------|-----|
| `bookId` | `{MMDD}{a-z}` 形式のBook固有ID | `0219a` |
| `R{n}` | Regen世代。省略=R0（オリジナル）。R1〜が再生成 | `R1`, `R2` |
| `scene` | `S{番号}{subletter?}_{説明}` 形式のシーンID | `S01c_rain` |
| `variant` | バリアントサフィックス（1〜3文字）。省略=ベース | `A`, `B`, `C` |

**具体例:**
```
0219a_S01c_rain              ← R0, base（オリジナル）
0219a_R1_S01c_rain           ← R1, base（純粋regen、同プロンプト再生成）
0219a_R1_S01c_rain_A         ← R1, variant A（別プロンプトの再生成）
0219a_R1_S01c_rain_B         ← R1, variant B
0219a_S02b_shopping          ← R0, base
0219a_S02b_shopping_A        ← R0, variant A（初期バリアント）
0219a_R2_S02b_shopping_A     ← R2, variant A のregen
```

**S3上のディレクトリ構造:**
```
gallery/experiments/
  20260227_animagine-xl-4.0/
    0219a_S01c_rain/           ← R0 base
      full/seed42.png
      thumb/seed42.png
    0219a_R1_S01c_rain_A/      ← R1 variant A
      full/seed42.png
      ...
```

#### バリアントUI

バリアントを持つページ（`S01c_rain` に対して `_A`, `_B`, `_C` が存在）は、
タイムラインでは1ページとして統合表示される。

- **バリアントタブ**: `[Original] [A] [B] [C]` — Candidateエリア上部に表示
- **タブ切替**: タブクリックで表示するバリアントを即座に切替
- **Compareモード**: `⇔ Compare` → 並列パネル比較。`+ Panel` で最大10パネル追加
- **各パネルに✕**: 個別パネルを閉じる。`✕ All` で全パネル閉じ
- **プレビュー縮小**: Compare中はメインプレビュー画像が縮小され、パネルに幅を譲る
- バリアントが1つ（baseのみ）のページではタブ非表示

#### バリアント検出ロジック（2.5パス）

`openBook()` 内でS3の実験データから自動検出:

```
Pass 1:   R0実験のsceneKeyを収集 → baseScenes
Pass 1.5: baseScenes内で「他のbase + '_' + 短suffix(≤3文字)」にマッチするものをR0バリアントに再分類
Pass 2:   各実験を分類:
          - R0 & r0VariantMap にある → そのベースシーンに統合（variant=suffix）
          - R{n} & baseに完全一致 → 純粋regen（variant="base"）
          - R{n} & baseに前方一致 → バリアント（variant=suffix）
          - マッチなし → 新規ページ（variant="base"）
```

## 評価データ形式 (v2)

`s3://r18-anime-assets/gallery/user-data/ratings.json`:
```json
{
  "_version": 2,
  "images": {
    "gallery/experiments/.../full/seed42.png": {
      "scores": { "quality": 4, "fidelity": 3, "anatomy": 5, "nsfw": 4, "overall": 4 },
      "comment": "色彩は良いが手の描写がやや甘い",
      "updated_at": "2026-02-15T12:00:00Z"
    }
  },
  "models": {
    "wai-nsfw-v16": {
      "comment": "バランス良い。本編メインの第一候補",
      "verdict": "adopt",
      "updated_at": "2026-02-15T14:00:00Z"
    }
  }
}
```

## デプロイ

```bash
# フロントエンドのみ（実験データ・評価データは除外）
aws s3 sync gallery/ s3://r18-anime-assets/gallery/ \
  --exclude 'experiments/*' --exclude 'user-data/*'

# CloudFrontキャッシュ無効化
aws cloudfront create-invalidation --distribution-id E337XPLJ3WBB11 --paths "/gallery/*"
```

⚠️ `--delete` フラグは使用禁止（Lambda展開データが消える）

## 実験データのアップロード

```bash
# batch-experiment.sh で自動パッケージ＆アップロード
./scripts/batch-experiment.sh --auto /path/to/generated/images

# S3にZipがアップロードされると、Lambda（S3イベントトリガー）が自動展開
# gallery/experiments/{id}/thumb/ と full/ にサムネイル＆フル画像が展開される
```
