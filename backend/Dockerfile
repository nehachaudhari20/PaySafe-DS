FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

WORKDIR /app

COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY proto/payment.proto /proto/payment.proto
COPY backend /app

RUN python scripts/generate_proto.py

EXPOSE 8000
ENTRYPOINT ["python", "entrypoint.py"]
