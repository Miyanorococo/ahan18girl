# セッション記録: 2026-02-15〜02-16

## AWS Batch + Step Functions 移行 ✅
- 13モデル並列テスト SUCCEEDED。本番化完了。
- CloudFormation: `aws/batch-cloudformation.yml` (スタック: `r18-anime-batch`)
- Docker: `r18-anime-eval` (ECR)。entrypoint.shでS3からプロンプト動的DL。
- 実行: `./scripts/start-batch-eval.sh`
- プロンプト切替: S3の`eval-scripts/eval-prompts.json`を差し替えるだけ（Docker再ビルド不要）

## 画像生成実験（5回、計3,342+ experiments）
| prefix | テーマ | 方式 |
|---|---|---|
| P01-P11 | モデル別プロンプト(110) | Fleet |
| UP01-UP11 | 統一WAI(122) | Fleet |
| TN01-TN05 | 触手NSFW(5) | Fleet |
| SM01-SM05 | SMプレイ(10) | Fleet |
| NR01-NR05 | ナース(5) | Step Functions |

## S3レジューム問題
- 同じprompt_id+日付だとスキップされる。prefix変更(P→UP)で回避。
- eval-prompts.jsonのS3上書き問題あり。Fleet起動前にS3にアップ必須。

## Gallery Model Grid
- テーマフィルタバー + シーンラベル + 最新日時
- regex: `^([A-Z]+)(\d+)_(.+)$` で全prefix対応
- テーマはthemeNameで統合（P01とUP01が同じ「人妻」に）

## Layer 2 制御技術テスト結果
- **#10 IP-Adapter**: weight 0.3-0.5最適。0.7+は色崩壊。Face版も動作確認
- **#9 Depth**: DepthAnything + CN Union で衣装/背景変更成功
- **#28 ControlNet Union**: standard/promax両方動作。構図維持に有効
- **#8 DWPose**: モデルDL失敗→修正スクリプト準備済み(S3: layer2_fix_and_test.py)
- **#12 ADetailer**: Impact-Pack依存関係→修正スクリプト準備済み
- **#13 Upscale**: mask_blurパラメータ追加→修正スクリプト準備済み

## Layer 2 最終結果

| テスト | 状態 | 結果 |
|---|---|---|
| #8 DWPose | ✅ | ポーズ抽出+転送 成功（SSM版）。Batchテストでは Impact-Pack依存で失敗 |
| #9 Depth | ✅ | DepthAnything+CN Union で衣装/背景変更成功 |
| #10 IP-Adapter | ✅ | weight 0.3-0.5最適。Face版も動作 |
| #28 CN Union | ✅ | standard/promax 両方動作 |
| #12 ADetailer | ✅ | Impact-Subpack + SAM model + bbox/face_yolov8m.pt で成功 |
| #13 Upscale | ✅ | mask_blur=8, batch_size=1, tiled_decode=False で成功 (3.8MB, 65s) |

## Layer 2 バッチテスト結果（2026-02-17）
generate-eval.py --layer2-test で64枚生成成功:
- IP-Adapter: 45枚（5 weights × 3 scenes × 3 seeds）
- CN Union: 9枚（3 strengths × 3 scenes）
- Depth: 7枚（extract + 2 scenes × 3 seeds）
- Reference: 3枚
- DWPose: 0枚（Impact-Pack依存で失敗）
修正が必要だった問題: boto3欠如、ComfyUIデッドロック（dill未インストール）

## ComfyUI KSampler ハング問題（根本原因特定済み）
- AMI の systemd ComfyUI サービスと UserData 手動起動が競合
- Fleet txt2img は偶然動く（systemd が /data マウント前に起動失敗するため）
- Layer 2 テストでは依存関係インストール後に systemd が成功→ポート競合/CUDA汚染
- **修正方法**: AMI 再構築時に systemd を disabled にし、UserData でのみ起動する方式に統一
- 必要な追加パッケージ: boto3, dill, opencv-python-headless, ultralytics(--no-deps)

## ComfyUI SSM経由ハング問題（参考）
- ComfyUI 0.13.0 + AMI ami-0ddff4465ad04bfa5 でSSM経由起動時にKSamplerがハング
- Batch/Fleet（UserData経由）では正常動作
- 原因: systemd vs UserData の起動環境差（CUDA パス、環境変数等）
- 対策案: Batch経由でテスト実行、またはAMI再構築

## 未解決の修正（次回実行）
S3に修正スクリプト保存済み: `s3://r18-anime-assets/eval-scripts/layer2_fix_and_test.py`
```bash
aws s3 cp s3://r18-anime-assets/eval-scripts/layer2_fix_and_test.py /tmp/ --region us-east-1
cd /data/ComfyUI && python3 /tmp/layer2_fix_and_test.py
```

## プロンプトバックアップ
assets/templates/ に6バージョン保存:
- eval-prompts-v1-per-model.json（モデル別）
- eval-prompts-v2-unified-anime.json（統一WAI）
- eval-prompts-v4-tentacle.json（触手）
- eval-prompts-v5-sm-play.json（SM）
- eval-prompts-v6-nurse.json（ナース）
- eval-prompts-realistic-gravure.json（リアルグラビア）

## Obsidianドキュメント
- 26_プロンプトカタログ.md
- 27_AIグラビア連載60回分析.md
- 28_セッション記録_20260215-16.md

## Docker再ビルド時の注意
- onnxruntimeをDockerfileに追加すること（aesthetic scorer用）
- 現在のイメージにはonnxruntime未インストール
