FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv git curl unzip \
    && curl -s "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip /var/lib/apt/lists/*

# ComfyUI
RUN git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git /opt/ComfyUI

WORKDIR /opt/ComfyUI

# Python dependencies (PyTorch CUDA 12.4 + ComfyUI requirements)
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir \
        torch torchvision torchaudio \
        --index-url https://download.pytorch.org/whl/cu124 \
    && pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir boto3 Pillow onnxruntime

# Create model directories (populated at runtime from S3)
RUN mkdir -p models/checkpoints models/vae models/loras \
             models/controlnet models/upscale_models \
             output/eval

# Copy evaluation scripts
COPY scripts/generate-eval.py /opt/eval/scripts/generate-eval.py
COPY assets/templates/eval-prompts.json /opt/eval/assets/templates/eval-prompts.json

# Entrypoint
COPY batch/entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh

ENV COMFYUI_URL=http://127.0.0.1:8188
ENV S3_BUCKET=r18-anime-assets
ENV PROMPTS_S3_KEY=eval-scripts/eval-prompts.json
ENV OUTPUT_DIR=/opt/ComfyUI/output/eval

ENTRYPOINT ["/opt/entrypoint.sh"]
