FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && python -m playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY app.py schemas.py index.html ./
COPY providers/ providers/
COPY services/ services/
COPY static/ static/
COPY data/ data/
COPY examples/ examples/

ENV PORT=8000
EXPOSE 8000

CMD ["python", "-c", "import os, uvicorn; uvicorn.run('app:app', host='0.0.0.0', port=int(os.environ.get('PORT', '8000')))"]
