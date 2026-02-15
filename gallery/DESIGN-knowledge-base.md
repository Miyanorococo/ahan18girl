# Knowledge Base タブ設計書

## 目的

評価データ（ratings.json）から競争優位となる知見を自動計算・可視化し、
制作時に即座に参照できるようギャラリー内に統合する。

## 既存アーキテクチャとの整合

- **ファイル追加**: `gallery/js/knowledge-base.js`（mixin）
- **変更ファイル**: `gallery/index.html`（ナビ+ビュー追加）、`gallery/js/app.js`（mixin統合+ルート追加）
- **新規Lambda/API**: 不要（全てクライアント側計算）
- **データソース**: 既存の`ratings.json` v2 + `experiments` API
- **計算ベース**: dashboard.jsの`_computeDashboardStats()`と`_computeHeatmap()`を再利用

## 画面構成

```
┌─────────────────────────────────────────────────────────────┐
│ Nav: Experiments | Model Grid | Dashboard | Knowledge Base  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─── タブ切替 ───────────────────────────────────────────┐ │
│  │ Decision Matrix │ Model Cards │ Prompt Library │ Export │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                             │
│  (以下、選択タブに応じた内容)                               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### サブタブ 1: Decision Matrix（モデル決定マトリクス）

**目的**: ジャンル×タイプ→推奨モデルを一目で分かるヒートマップ

**表示**:
```
           │ 人妻  │ JK   │ 催眠  │ 百合  │ おね  │ NTR  │ ファン│ 陵辱  │ ふた  │ モン  │ 立ち  │
───────────┼───────┼──────┼───────┼───────┼───────┼──────┼───────┼───────┼───────┼───────┼───────┤
 explicit  │ v16   │ v14  │ v11   │ v16   │ v14   │ v16  │ v14   │ v11   │ Illj  │ Nova  │ v16   │
 sensitive │ v16   │ v16  │ v14   │ v16   │ v14   │ v14  │ Nova  │ v16   │ v14   │ Nova  │ v16   │
 sex       │ v14   │ v14  │ v16   │ v16   │ v14   │ v14  │ v16   │ v14   │ v16   │ v14   │ v14   │
 ...       │       │      │       │       │       │      │       │       │       │       │       │
```

セルの色: スコアの高さでグラデーション（赤=低い、黄=中間、緑=高い）
セルクリック: 該当モデル×ジャンル×タイプの画像一覧をポップアップ表示
セル内テキスト: 1位モデル名（短縮） + スコア

**計算ロジック**:
1. experiments配列からgenre（`prompt_summary`の`_`前）とtype（`_`後）を抽出
2. ratings.imagesから各画像のスコアを取得
3. model × genre × type ごとにoverallスコアの平均を計算
4. 各genre×typeセルで最高平均のモデルを1位として表示

**データ構造**:
```javascript
kb.matrix = {
  genres: ['人妻', 'JK/学園', ...],
  types: ['explicit', 'sensitive', 'sex', 'penis', 'toy', 'orgasm', 'pregnant', 'lactation', 'birth', 'ejac'],
  cells: {
    '人妻_explicit': {
      rankings: [
        { model: 'wai-nsfw-illustrious-v16', avgScore: 4.2, count: 5, favCount: 2 },
        { model: 'wai-nsfw-illustrious-v14', avgScore: 3.8, count: 5, favCount: 1 },
        ...
      ]
    }
  }
}
```

### サブタブ 2: Model Cards（モデル別サマリー）

**目的**: モデルごとの強み・弱みを自動サマリー

**表示（1モデルあたり）**:
```
┌──────────────────────────────────────────────┐
│ WAI-NSFW v16                      ★4.1 avg  │
│ ────────────────────────────────────────────  │
│ 強み: プロンプト忠実度 ★4.5, 色彩 ★4.3      │
│ 弱み: 人体 ★3.2 (手の描写に課題)            │
│ 得意ジャンル: 人妻, NTR, 立ち絵             │
│ 苦手ジャンル: ふたなり, モンスター娘         │
│ ♥お気に入り率: 15% (7/45)                   │
│ 判定: ✅ 採用 (本編メイン候補)              │
│ メモ: LoRAが効きにくい点に注意               │
│ ────────────────────────────────────────────  │
│ [レーダーチャート]  [詳細を見る]              │
└──────────────────────────────────────────────┘
```

**計算ロジック**:
- dashboard._computeDashboardStats()のmodelStats再利用
- 強み/弱み: 5軸のうちスコア上位2つ/下位2つ
- 得意/苦手ジャンル: heatmapデータからtop 3 / bottom 3
- お気に入り率: favCount / totalRated
- 判定: ratings.models[model].verdict（手動設定）
- メモ: ratings.models[model].comment（手動設定）

### サブタブ 3: Prompt Library（プロンプトライブラリ）

**目的**: テスト済みプロンプトを品質順にランキング、本番テンプレートとして再利用

**表示**:
```
# プロンプト品質ランキング（全モデル平均）

1. P01_se (人妻/sensitive) ★4.3 avg ← 全モデルでスコア高い
   "nsfw, sensitive, 1girl, solo, mature female, housewife..."
   [コピー] [詳細]

2. P07_se (ファンタジー/sensitive) ★4.1 avg
   "nsfw, sensitive, 1girl, elf, pointy ears..."
   [コピー] [詳細]

...
```

フィルタ: ジャンル、タイプ、最低スコア
ソート: 平均スコア、お気に入り率、特定モデルでのスコア

**計算ロジック**:
1. prompt_summary → プロンプトID
2. 全モデルの該当プロンプトのoverallスコア平均
3. ソート: 平均スコア降順

### サブタブ 4: Export Hub

**目的**: 知見をObsidian/Claude/外部ツールに一括出力

**出力形式**:
- **Obsidian Markdown**: モデルマトリクス + カード + プロンプトランキングを1つのMDファイルに
- **Claude連携 JSON**: 構造化データ（モデル推奨、プロンプトテンプレート）
- **production-prompts.json**: 上位プロンプトだけを抽出した本番用テンプレート

**エクスポートボタン**:
- 📋 Copy Markdown（クリップボード）
- 📋 Copy JSON（クリップボード）
- 💾 Download production-prompts.json

## パフォーマンス設計

**問題**: 監査で指摘されたO(N×M)問題（7150画像×500実験で350万回比較）

**対策**: Knowledge Base計算はDashboard initと同じタイミングで行い、結果をキャッシュ。
```javascript
kb._cache = null;  // initKnowledgeBase()で計算、タブ切替時はキャッシュ利用
```

experiment→model マッピングを`Map`で事前構築し、O(1)ルックアップ:
```javascript
// 事前構築（1回のみ）
const imgToModel = new Map();
for (const exp of experiments) {
  for (const img of exp.images) {
    imgToModel.set(img.full_url, exp.model);
  }
}
// ルックアップ: O(1)
const model = imgToModel.get(ratingKey);
```

## ファイル変更一覧

| ファイル | 変更内容 |
|---|---|
| `gallery/js/knowledge-base.js` | 新規: knowledgeBaseMixin() |
| `gallery/index.html` | ナビリンク追加 + Knowledge Baseビューテンプレート追加 |
| `gallery/js/app.js` | `...knowledgeBaseMixin()` 追加 + ルーティング追加 |
| `gallery/css/gallery.css` | Knowledge Base用スタイル追加 |
