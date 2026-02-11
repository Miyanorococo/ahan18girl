#!/bin/bash
set -euo pipefail

# =============================================================================
# EC2 Initial Setup Script for r18_anime
# Runs on Deep Learning AMI (Ubuntu 22.04) after launch.
# Installs ComfyUI + custom nodes on persistent EBS volume at /data.
#
# Usage:
#   chmod +x setup.sh
#   sudo ./setup.sh
#
# Idempotent: safe to run multiple times.
# =============================================================================

# --- Configuration ---
DATA_DIR="/data"
COMFYUI_DIR="${DATA_DIR}/ComfyUI"
VENV_DIR="${COMFYUI_DIR}/venv"
EBS_DEVICE="/dev/xvdf"
ENV_FILE="${DATA_DIR}/.env"

# Source environment config if present
if [[ -f "${ENV_FILE}" ]]; then
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
fi

S3_BUCKET="${S3_BUCKET:-r18-anime-assets}"
AWS_REGION="${AWS_REGION:-us-east-1}"

# --- Logging ---
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

log_section() {
    echo ""
    echo "============================================================"
    log "$*"
    echo "============================================================"
}

# --- Pre-flight checks ---
if [[ $EUID -ne 0 ]]; then
    echo "This script must be run as root (sudo ./setup.sh)"
    exit 1
fi

log_section "Starting EC2 setup for r18_anime"

# =============================================================================
# 1. Mount EBS Volume
# =============================================================================
log_section "Step 1: Mount EBS volume at ${DATA_DIR}"

mkdir -p "${DATA_DIR}"

if mountpoint -q "${DATA_DIR}"; then
    log "EBS volume already mounted at ${DATA_DIR}, skipping."
else
    # Wait for EBS device to appear (UserData may have just attached it)
    WAIT_COUNT=0
    while [[ ! -b "${EBS_DEVICE}" ]] && [[ ${WAIT_COUNT} -lt 30 ]]; do
        log "Waiting for ${EBS_DEVICE} to appear... (${WAIT_COUNT}/30)"
        sleep 2
        WAIT_COUNT=$((WAIT_COUNT + 1))
    done

    if [[ ! -b "${EBS_DEVICE}" ]]; then
        log "ERROR: ${EBS_DEVICE} not found after 60 seconds."
        log "Make sure the EBS volume is attached to this instance."
        exit 1
    fi

    # Create filesystem if needed
    if ! blkid "${EBS_DEVICE}" >/dev/null 2>&1; then
        log "Creating ext4 filesystem on ${EBS_DEVICE}"
        mkfs.ext4 "${EBS_DEVICE}"
    fi

    log "Mounting ${EBS_DEVICE} at ${DATA_DIR}"
    mount "${EBS_DEVICE}" "${DATA_DIR}"

    # Add to fstab if not already present
    if ! grep -q "${EBS_DEVICE}" /etc/fstab; then
        log "Adding ${EBS_DEVICE} to /etc/fstab"
        echo "${EBS_DEVICE} ${DATA_DIR} ext4 defaults,nofail 0 2" >> /etc/fstab
    fi
fi

chown -R ubuntu:ubuntu "${DATA_DIR}"
log "EBS volume ready at ${DATA_DIR}"

# =============================================================================
# 2. Install ComfyUI
# =============================================================================
log_section "Step 2: Install ComfyUI"

if [[ -d "${COMFYUI_DIR}/.git" ]]; then
    log "ComfyUI already cloned, pulling latest changes"
    sudo -u ubuntu git -C "${COMFYUI_DIR}" pull --ff-only || true
else
    log "Cloning ComfyUI"
    sudo -u ubuntu git clone https://github.com/comfyanonymous/ComfyUI.git "${COMFYUI_DIR}"
fi

# Create Python virtual environment
if [[ -d "${VENV_DIR}" ]]; then
    log "Python venv already exists at ${VENV_DIR}"
else
    log "Creating Python virtual environment"
    sudo -u ubuntu python3 -m venv "${VENV_DIR}"
fi

# Install/upgrade requirements
log "Installing ComfyUI requirements"
sudo -u ubuntu "${VENV_DIR}/bin/pip" install --upgrade pip
sudo -u ubuntu "${VENV_DIR}/bin/pip" install -r "${COMFYUI_DIR}/requirements.txt"

# Install PyTorch with CUDA support (match DLAMI CUDA version)
log "Ensuring PyTorch with CUDA support is installed"
sudo -u ubuntu "${VENV_DIR}/bin/pip" install torch torchvision torchaudio \
    --index-url https://download.pytorch.org/whl/cu124

log "ComfyUI installation complete"

# =============================================================================
# 3. Install Custom Nodes
# =============================================================================
log_section "Step 3: Install custom nodes"

CUSTOM_NODES_DIR="${COMFYUI_DIR}/custom_nodes"
mkdir -p "${CUSTOM_NODES_DIR}"
chown ubuntu:ubuntu "${CUSTOM_NODES_DIR}"

install_custom_node() {
    local repo_url="$1"
    local node_name
    node_name=$(basename "${repo_url}" .git)
    local node_dir="${CUSTOM_NODES_DIR}/${node_name}"

    if [[ -d "${node_dir}/.git" ]]; then
        log "  ${node_name}: already installed, updating"
        sudo -u ubuntu git -C "${node_dir}" pull --ff-only || true
    else
        log "  ${node_name}: cloning"
        sudo -u ubuntu git clone "${repo_url}" "${node_dir}"
    fi

    # Install node requirements if they exist
    if [[ -f "${node_dir}/requirements.txt" ]]; then
        log "  ${node_name}: installing requirements"
        sudo -u ubuntu "${VENV_DIR}/bin/pip" install -r "${node_dir}/requirements.txt"
    fi

    # Run install.py if it exists
    if [[ -f "${node_dir}/install.py" ]]; then
        log "  ${node_name}: running install.py"
        sudo -u ubuntu "${VENV_DIR}/bin/python" "${node_dir}/install.py" || true
    fi
}

# ComfyUI-Manager (node management UI)
install_custom_node "https://github.com/ltdrdata/ComfyUI-Manager.git"

# comfyui-reactor-node (face swap / face restore)
install_custom_node "https://github.com/Gourieff/comfyui-reactor-node.git"

# ComfyUI-Impact-Pack (ADetailer equivalent - face/hand detail)
install_custom_node "https://github.com/ltdrdata/ComfyUI-Impact-Pack.git"

# ComfyUI_IPAdapter_plus (IP-Adapter for character consistency)
install_custom_node "https://github.com/cubiq/ComfyUI_IPAdapter_plus.git"

# ComfyUI-AnimateDiff-Evolved (animation generation)
install_custom_node "https://github.com/Kosinkadink/ComfyUI-AnimateDiff-Evolved.git"

# ComfyUI_essentials (utility nodes)
install_custom_node "https://github.com/cubiq/ComfyUI_essentials.git"

# comfyui-art-venture (PuLID support for character consistency)
install_custom_node "https://github.com/artventureX/comfyui-art-venture.git"

# ComfyUI_UltimateSDUpscale (tiled upscaling)
install_custom_node "https://github.com/ssitu/ComfyUI_UltimateSDUpscale.git"

log "Custom nodes installation complete"

# =============================================================================
# 4. Create Model Directories
# =============================================================================
log_section "Step 4: Create model directories"

MODEL_DIRS=(
    "checkpoints"
    "loras"
    "controlnet"
    "upscale_models"
    "vae"
    "embeddings"
    "clip"
    "ipadapter"
    "pulid"
    "animatediff_models"
)

for dir in "${MODEL_DIRS[@]}"; do
    target="${COMFYUI_DIR}/models/${dir}"
    if [[ -d "${target}" ]]; then
        log "  ${dir}/: exists"
    else
        log "  ${dir}/: creating"
        sudo -u ubuntu mkdir -p "${target}"
    fi
done

log "Model directories ready"

# =============================================================================
# 5. Create systemd Service
# =============================================================================
log_section "Step 5: Configure ComfyUI systemd service"

SERVICE_FILE="/etc/systemd/system/comfyui.service"

cat > "${SERVICE_FILE}" << 'UNIT'
[Unit]
Description=ComfyUI - Stable Diffusion Web UI
After=network.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/data/ComfyUI
EnvironmentFile=-/data/.env
ExecStart=/data/ComfyUI/venv/bin/python /data/ComfyUI/main.py \
    --listen 127.0.0.1 \
    --port 8188 \
    --highvram
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

# Resource limits
LimitNOFILE=65536
LimitNPROC=65536

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable comfyui.service

# Start the service if not already running
if systemctl is-active --quiet comfyui.service; then
    log "ComfyUI service already running, restarting"
    systemctl restart comfyui.service
else
    log "Starting ComfyUI service"
    systemctl start comfyui.service
fi

log "ComfyUI service configured (127.0.0.1:8188, SSH tunnel only)"

# =============================================================================
# 6. Final Summary
# =============================================================================
log_section "Setup complete"

log "ComfyUI installed at: ${COMFYUI_DIR}"
log "Python venv at:       ${VENV_DIR}"
log "Models directory:     ${COMFYUI_DIR}/models/"
log "Custom nodes:         ${CUSTOM_NODES_DIR}/"
log "S3 bucket:            ${S3_BUCKET}"
log ""
log "Access ComfyUI via SSH tunnel:"
log "  ssh -L 8188:127.0.0.1:8188 ubuntu@<instance-ip>"
log "  Then open http://localhost:8188 in your browser"
log ""
log "Service management:"
log "  sudo systemctl status comfyui"
log "  sudo systemctl restart comfyui"
log "  sudo journalctl -u comfyui -f"
log ""
log "Next steps:"
log "  1. Sync models from S3:  aws s3 sync s3://${S3_BUCKET}/models/ ${COMFYUI_DIR}/models/ --region ${AWS_REGION}"
log "  2. Upload workflows to:  ${COMFYUI_DIR}/user/default/workflows/"
