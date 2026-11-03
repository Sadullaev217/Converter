# Single-container image for the whole app: Flask serves the API *and* the
# static frontend, and shells out to the Node pdf-to-docx tool.
#
# System tools needed at runtime:
#   - Node.js            -> runs scripts/pdf-to-docx.js (the PDF -> DOCX rebuild)
#   - Poppler            -> pdfimages / pdftotext / pdftohtml used by that tool
#   - LibreOffice Writer -> high-fidelity docx -> pdf (soffice --convert-to)
#     Writer only (not full LibreOffice) to keep the image lean; metric-
#     compatible fonts (Liberation) make common Office docs render correctly.
FROM python:3.12-slim-bookworm

# Node 20 (NodeSource) + Poppler + LibreOffice Writer, then clean apt caches.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg poppler-utils \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends \
         nodejs \
         libreoffice-writer libreoffice-core \
         fonts-liberation fonts-liberation2 fonts-dejavu-core \
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
# via __file__, so they work regardless of the chdir. Default to 1 worker
# because LibreOffice (docx->pdf) is memory-heavy and would OOM a small/free
# instance with more; raise WEB_CONCURRENCY on a bigger plan for concurrency.
CMD ["sh", "-c", "exec gunicorn --chdir backend app:app --bind 0.0.0.0:${PORT:-5050} --workers ${WEB_CONCURRENCY:-1} --threads 4 --timeout 120"]
