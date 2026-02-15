import io

from PIL import Image


def generate_thumbnail(image_bytes, max_size=300):
    """Resize image so longest edge is max_size and convert to WebP."""
    img = Image.open(io.BytesIO(image_bytes))
    img.thumbnail((max_size, max_size), Image.LANCZOS)

    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")

    buf = io.BytesIO()
    img.save(buf, format="WebP", quality=80)
    return buf.getvalue()
