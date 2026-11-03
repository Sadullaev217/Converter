# Single-container image for the whole app: Flask serves the API *and* the
# static frontend, and shells out to the Node pdf-to-docx tool.
#
# System tools always installed:
#   - Node.js   -> runs scripts/pdf-to-docx.js (the PDF -> DOCX rebuild)
#   - Poppler   -> pdfimages / pdftotext / pdftohtml used by that tool
#
# LibreOffice (for high-fidelity docx<->pdf and layout-accurate pdf->docx) is
# OPT-IN: it's ~400MB on disk and needs ~300-500MB RAM to run, which does NOT
# fit a 512MB free tier. Leaving it out keeps the image small and reliable on
# free hosting; the app detects its absence and falls back automatically
# (pdf->docx -> the editable Node rebuild, docx->pdf -> a text reflow).
#
# To enable the high-fidelity LibreOffice conversions, build with
#   --build-arg INSTALL_LIBREOFFICE=true
# on an instance with >= 1GB RAM (and set WEB_CONCURRENCY=1 there).
FROM python:3.12-slim-bookworm

ARG INSTALL_LIBREOFFICE=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg poppler-utils \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && if [ "$INSTALL_LIBREOFFICE" = "true" ]; then \
         apt-get install -y --no-install-recommends \
           libreoffice-writer libreoffice-draw libreoffice-core \
           fonts-liberation fonts-liberation2 fonts-dejavu-core ; \
       fi \
    && apt-get purge -y curl gnupg \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node dependency (docx). Copied first so this layer caches across code edits.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Python dependencies.
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Application source.
COPY . .

# Render (and most PaaS) inject PORT; default to 5050 for local `docker run`.
ENV PORT=5050 \
    HOST=0.0.0.0 \
    PYTHONUNBUFFERED=1
EXPOSE 5050

# gunicorn imports backend/app.py's `app`. Script paths inside the app resolve
# via __file__, so they work regardless of the chdir. 2 workers is fine for the
# lightweight image; drop WEB_CONCURRENCY to 1 if you enable LibreOffice (it's
# memory-heavy and would OOM a small instance with more).
CMD ["sh", "-c", "exec gunicorn --chdir backend app:app --bind 0.0.0.0:${PORT:-5050} --workers ${WEB_CONCURRENCY:-2} --threads 4 --timeout 120"]
