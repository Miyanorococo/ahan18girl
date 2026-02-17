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
- **推奨**: ComfyUI のバージョンを 0.12.x にダウングレードするか、新しい AMI をゼロから構築

## 成功パターン（唯一の64枚バッチ成功）
1. boto3 install
2. dill install
3. pkill -f "main.py.*8188"（systemd ComfyUI 強制終了）
4. 手動 ComfyUI 再起動
5. generate-eval.py --layer2-test 実行
