# Single-container image for the whole app: Flask serves the API *and* the
# static frontend, and shells out to the Node pdf-to-docx tool.
#
# System tools needed at runtime:
#   - Node.js    -> runs scripts/pdf-to-docx.js (the PDF -> DOCX rebuild)
#   - Poppler    -> pdfimages / pdftotext / pdftohtml used by that tool
# LibreOffice is deliberately NOT installed: the web pdf->docx route runs with
# --no-verify, and docx->pdf uses reportlab, so nothing here needs soffice.
FROM python:3.12-slim-bookworm

# Node 20 (NodeSource) + Poppler, in one layer, then clean up apt caches.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg poppler-utils \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
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
# via __file__, so they work regardless of the chdir.
CMD ["sh", "-c", "exec gunicorn --chdir backend app:app --bind 0.0.0.0:${PORT:-5050} --workers 2 --threads 2 --timeout 120"]
