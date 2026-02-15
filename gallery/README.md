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
