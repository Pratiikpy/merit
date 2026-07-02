# Merit NLI backend — free, self-hostable factual-consistency scorer (CPU-only, ~1-1.5GB image).
# Build:  docker build -t merit-nli .
# Run:    docker run -p 8000:8000 merit-nli
# Wire:   MERIT_NLI_URL=http://localhost:8000/score  MERIT_NLI_MODEL=vectara/hhem-2.1-open  (in Merit's env)
FROM python:3.11-slim

ENV HF_HOME=/models \
    TRANSFORMERS_OFFLINE=0 \
    MERIT_NLI_BACKEND=hhem \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake the default model into the image so the first request isn't a cold ~600MB download.
RUN python -c "from transformers import AutoModelForSequenceClassification as M; \
    M.from_pretrained('vectara/hallucination_evaluation_model', trust_remote_code=True)"

COPY . .
EXPOSE 8000
# 1 worker: each worker loads its own model copy (RAM x workers). Scale with replicas, not workers, on CPU.
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
