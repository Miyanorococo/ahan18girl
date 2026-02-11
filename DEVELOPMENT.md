# 開発方針

## Phase 1: AWS環境構築 + テスト制作（最初の1ヶ月）

### Week 1: AWS基盤

1. **サービスクォータ引き上げ**
   - AWS Console（us-east-1）でg6eインスタンスの制限引き上げ申請
   - g5も併せて申請（フォールバック用）
   - デフォルトで0の場合あり。承認に1-3営業日かかる

2. **インフラ構築**
   - `aws/cloudformation.yml`: VPC、セキュリティグループ(SSH自宅IP限定)、IAMロール(S3アクセス用インスタンスプロファイル)、EBS(暗号化有効)を定義（us-east-1）
   - `aws/setup.sh`: Deep Learning AMI起動、EBS作成、ComfyUIインストール
   - `aws/start-spot.sh`: g6e.xlargeスポット起動（推奨AZ: us-east-1c/d）
     - `--fallback g5` でg5.xlargeにフォールバック
     - `--on-demand` フラグでオンデマンド起動に切替可能
   - `aws/stop-instance.sh`: 停止（EBSは保持、コスト削減）
   - `aws/sync-models.sh`: S3からEBSへモデルファイル同期
   - `aws/sync-output.sh`: EBS output/ → S3へ生成画像同期
   - `aws/spot-monitor.sh`: スポット中断2分前通知を検知 → 自動S3同期
   - SSHトンネル設定（ComfyUI WebUIへのセキュアアクセス）
   - 初回セットアップ完了後にAMIスナップショット取得（再構築時間短縮）

3. **モデルダウンロード → S3保存**
   - WAI-NSFW-illustrious v16（~6.5GB）
   - Animagine XL 4.0 v4 Opt（~6.5GB）
   - Qwen-Image-2512
   - Z-Image Turbo
   - ControlNet モデル群
   - VAE、ADetailerモデル等

### Week 2: ComfyUI環境整備

4. **ComfyUIワークフロー構築**
   - `comfyui/workflows/anime-cg-base.json`: 基本的なアニメCG生成フロー
     - WAI v16 → ControlNet（ポーズ）→ ADetailer（顔・手修正）→ アップスケール
   - `comfyui/workflows/upscale-8k.json`: SUPIR高解像度化フロー
   - `comfyui/workflows/character-consistency.json`: IP-Adapter/PuLIDによるキャラ統一フロー

5. **プロンプトテンプレート作成**
   - `assets/templates/`: ジャンル別プロンプト雛形
   - WAI v16はIllustriousベースなのでDanbooruタグ形式

### Week 3-4: テスト制作 + プラットフォーム登録

6. **プラットフォーム登録**
   - FANZA同人サークル登録
   - Fantiaアカウント開設
   - DLSiteサークル確認

7. **テスト作品1本制作**
   - 10〜20枚のアニメCG集
   - 生成ログの保存フロー確立（`logs/` に自動保存）
   - FANZAに投稿 → 市場反応確認

---

## Phase 2: 量産体制（2-3ヶ月目）

8. **キャラクターLoRA作成**（`assets/characters/`）
   - オリジナルキャラ2-3体
   - Kohya_ssでLoRAトレーニング（AWS上で実行）

9. **制作フロー標準化**
   - 1作品あたりの標準工程をワークフロー化
   - 品質チェックリスト作成

10. **リリース体制確立**
    - FANZA月2-3本ペース
    - Fantiaサブスク開始（制作過程公開）

---

## Phase 3: 収益拡大（4-6ヶ月目）

11. **動画/ゲーム展開**
    - Wan 2.6セットアップ（Image-to-Video）
    - Ren'Pyでビジュアルノベル化
    - DLSiteゲームカテゴリ進出

12. **戦略B（フォトリアル系）準備**
    - getphat FLUX Reality v11のテスト（g5.xlargeのA10G 24GBで動作可能）
    - FANZA専用のリアル系ライン確立

---

## 開発時の注意

### AWS固有
- リージョン: us-east-1（GPUスポット最安）、推奨AZ: us-east-1c/d
- インスタンス停止し忘れに注意（EBSの課金は継続する）
- スポット中断対策: `spot-monitor.sh` が2分前通知を検知し自動S3同期
- g6eスポット不安定時は `start-spot.sh --fallback g5` でg5.xlargeに切替
- 緊急時は `start-spot.sh --on-demand` でオンデマンドに切替
- モデルファイルはS3に永続保存。EC2起動時にEBSへ同期
- 生成画像は作業終了時に `sync-output.sh` でS3に同期
- セキュリティグループ: SSH(22)のみ、自宅IP限定。ComfyUIポート(8188)は外部公開しない
- EC2にはIAMインスタンスプロファイルでS3アクセス（アクセスキーを置かない）
- EBSは暗号化有効で作成
- AMIスナップショットを定期取得（セットアップ時間短縮）

### 生成ログ
DLSiteで証明を求められる場合に備えて以下を記録:
- 使用モデル名・バージョン
- 使用LoRA
- プロンプト（positive/negative）
- サンプラー、ステップ数、CFG、シード値
- ポストプロセス内容

### Git管理
- `output/` と大きなモデルファイルは `.gitignore` に追加
- ワークフロー(.json)、スクリプト、テンプレートはGit管理
- 生成ログはGit管理（証拠として保全）
