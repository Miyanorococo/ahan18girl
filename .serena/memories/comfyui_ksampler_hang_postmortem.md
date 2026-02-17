# ComfyUI KSampler ハング問題 — 再発防止メモ

## 根本原因
AMI の systemd comfyui.service と UserData 手動起動が競合。
- Fleet txt2img は動く（systemd が /data マウント前に起動失敗するため）
- Layer 2 テストは失敗（deps インストール後に /data マウント済み → systemd が成功 → 競合）

## AMI 再構築時の必須チェックリスト
1. `systemctl disable comfyui && systemctl mask comfyui`
2. `venv/bin/pip install boto3 Pillow dill opencv-python-headless`
3. `venv/bin/pip install --no-deps ultralytics`
4. `venv/bin/pip install py-cpuinfo psutil scipy scikit-image`
5. ComfyUI-Impact-Subpack を custom_nodes/ にクローン
6. DWPose models (yolox_l.onnx, dw-ll_ucoco_384.onnx) をダウンロード
7. face_yolov8m.pt, sam_vit_b_01ec64.pth をダウンロード
8. IP-Adapter, ControlNet Union モデルをダウンロード
9. 4x_foolhardy_Remacri.pth を models/upscale_models/ にコピー

## UserData テンプレートの必須要素
```bash
systemctl stop comfyui 2>/dev/null || true
systemctl mask comfyui 2>/dev/null || true
# ... mount /data ...
cd /data/ComfyUI
source venv/bin/activate
python main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch &
```

## 追加調査結果（2026-02-17）
- systemd disabled (AMI v2) でも同じハング発生 → systemd は原因ではない
- --disable-cuda-malloc でも同じハング → cudaMallocAsync は原因ではない
- GPU: native アロケータでも 0% utilization
- 基本CUDA操作（torch.randn）は正常動作
- ComfyUI がプロンプトを受け取り、モデルをロードするが、KSampler の実行が始まらない
- **未解決**: Fleet の --models と --layer2-test の差が何を引き起こすか不明
- **次のステップ**: ComfyUI バージョンダウングレードまたは新規 AMI 作成

## 追加調査結果（2026-02-17 夜）
- parallel-eval.sh 経由で --models (Fleet コードパス) を実行 → 同じハング
- v1 AMI + 古いスナップショット + オリジナルコードでも失敗
- v2 AMI + systemctl stop + --disable-cuda-malloc でも失敗
- ポート競合（errno 98）は v1 AMI の systemd が原因で確認されたが、ハングの根本原因ではない
- 全ての修正を適用しても ComfyUI 0.13.0 の KSampler がハングする
- **可能性**: 以前の成功は特定のインスタンスタイプ/AZ/タイミングの偶然。再現性が低い
## 解決済み（2026-02-17 夜）

チーム調査（3エージェント並列）で根本原因を特定し修正:

### 修正内容（parallel-eval.sh UserData）
1. `systemctl stop comfyui` + `pkill` → ポート競合防止 + クリーンCUDA
2. `sleep 15` → EBS初期化待ち
3. `--gpu-only` → **CPUフォールバック防止（Docker版にはあったがFleet版になかった決定的差）**
4. `/object_info/KSampler` チェック → カスタムノード初期化完了保証
5. `clear_queue()` → タイムアウト時のキュースタック防止
6. `timeout 300→600` → 初回モデルロード時間に対応

### 結果
- Fleet txt2img 生成復旧: 648枚PNG、136プロンプト成功
- wai-v11 が 124プロンプト/612枚を完走

### 根本原因（Web リサーチで発見）
- ComfyUI 0.13.0 の `comfy_aimdo` (DynamicVRAM) + 非同期オフロード
- PyTorch cu128 + CUDA 13.0 ドライバの不整合
- GitHub Issue #10613: 同症状（未解決）
- `--normalvram` は `--gpu-only` と排他（同時指定不可）
- `--disable-async-offload` 追加でドライバクラッシュ発生（nvidia-smi 通信失敗）
- **真の根本原因: NVIDIA Driver 580.126.09 がモデルロード時にクラッシュ**
- nvidia-smi は ComfyUI 起動時OK → モデルウェイトのVRAM転送で通信不能に
- Driver 550 へのダウングレードを検証中

## 成功パターン（唯一の64枚バッチ成功）
1. boto3 install
2. dill install
3. pkill -f "main.py.*8188"（systemd ComfyUI 強制終了）
4. 手動 ComfyUI 再起動
5. generate-eval.py --layer2-test 実行
