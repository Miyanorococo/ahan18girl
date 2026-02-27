# セッション記録: 2026-02-17〜18

## 主な成果

### KSampler ハング問題 — 根本原因特定・部分解決
- **unattended-upgrades** がカーネルを自動更新 → NVIDIA DKMS 不整合 → ドライバクラッシュ
- AMI v4 (ami-008029be8d4ca532b): kernel -1046 削除、GRUB -1045 pin、unattended masked
- Fleet --models (txt2img) 復旧: 70+ experiments + L2W 9枚生成成功
- Layer 2 --layer2-test: 初回モデルロードがハング（ComfyUI 0.13.0 固有、未解決だが影響低）

### 修正一覧
1. systemctl stop + pkill（ポート競合防止）
2. sleep 15（EBS初期化待ち）
3. --gpu-only（CPUフォールバック防止）— Docker版にはあったがFleet版になかった
4. /object_info/KSampler チェック（ノード初期化完了保証）
5. warmup_model()（モデル事前ロード）— 900秒タイムアウト
6. clear_queue()（タイムアウト時キュー解放）
7. unattended-upgrades masked + カーネルpin（AMI v4）
8. eval-prompts.json per-run ユニークS3キー（競合防止）
9. WORKER_MODELS 13→7モデル同期
10. Docker再ビルド: PROMPTS_S3_KEY + onnxruntime

### AMI バージョン
| ver | AMI ID | 状態 |
|---|---|---|
| v1 | ami-0ddff4465ad04bfa5 | 旧（systemd有効、unattended有効） |
| v2 | ami-0224a0f133066816e | systemd disabled + deps |
| v3 | ami-0af264397e3c4aba7 | + unattended masked（kernel -1046残存） |
| **v4** | **ami-008029be8d4ca532b** | **推奨: -1046削除 + GRUB pin** |

### Layer 2 テスト最終データ（84枚）
- IP-Adapter: 57枚 — weight 0.3-0.5 最適
- CN Union: 11枚 — strength 0.5 推奨
- Depth: 9枚 — DepthAnything + CN Union 成功
- DWPose: 4枚 — ポーズ抽出+転送 確認
- ADetailer: 1枚 — FaceDetailer+SAM 確認
- Upscale: 2枚 — 2x Remacri 確認

### 未解決（影響低）
- Layer 2 バッチ初回モデルロードハング — ComfyUI 0.13.0 + cudaMallocAsync + EBS cold read
- AMI ゼロ構築時に対応予定。本番に影響なし

### 追加発見（エージェント最終報告）
- **「ハング」は実はEBSスナップショットの lazy restore が遅いだけだった可能性**
- 最後のOn-Demand実行は外部terminate（私）で中断。ウォームアップはまだ進行中だった
- EBS cold read で 7GB モデルファイルの初回読み取りに 20分以上かかる
- **次回: 30分以上待ってから判断すること**
- wait_for_completion に進捗ログがないため「ハング」に見える → ログ追加推奨

### ドキュメント
- 29_ComfyUI_KSamplerハング障害レポート.md（全調査結果）
- Serena Memory: comfyui_ksampler_hang_postmortem（根本原因+修正手順）
