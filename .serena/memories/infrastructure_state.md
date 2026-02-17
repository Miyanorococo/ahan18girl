# インフラ状態（2026-02-16時点）

## AMI
- **v2 (推奨)**: ami-0224a0f133066816e — systemd disabled + boto3/dill/opencv/onnxruntime + Impact-Subpack + 全制御モデル
- v1 (旧): ami-0ddff4465ad04bfa5 — systemd 有効（KSampler ハング問題あり）

## AWS Batch + Step Functions（本番）
- Stack: r18-anime-batch (us-east-1)
- State Machine: r18-anime-eval
- ECR: r18-anime-eval:latest
- Job Queue: r18-anime-eval-queue (Spot CE優先 → OD CE fallback)
- S3モデル: 13/13完了 (s3://r18-anime-assets/models/checkpoints/)
- S3プロンプト: s3://r18-anime-assets/eval-scripts/eval-prompts.json

## Gallery
- URL: https://d2m524k99quzzr.cloudfront.net/gallery/index.html
- Lambda: r18-anime-gallery
- CloudFront: E337XPLJ3WBB11
- Index: 3,342+ experiments

## モデル暫定選定（手動評価433枚）
- Nova Anime XL: ★率18% → 本編メイン候補A
- Animagine XL 4.0: ★率21% → 本編メイン候補B
- WAI Branch-Rouwei: ★率9% → NSFW特化候補
- Pony/Illustrij/SD1.5系: 候補外

## 常時稼働コスト
- NAT Gateway: ~$32/月
- ALB: ~$18/月
- VPC Endpoints (SSM×3): ~$22/月
- EBS 200GB: ~$16/月
- 合計: ~$88/月（EC2不使用時）
