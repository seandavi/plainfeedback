FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PATH="/app/.venv/bin:$PATH"
COPY pyproject.toml uv.lock README.md ./
COPY src ./src
RUN uv sync --frozen --no-dev
RUN useradd --system --uid 10001 app
USER app
EXPOSE 8000
# --no-access-log: uvicorn's log line includes client IP; the app logs its own.
CMD ["uvicorn", "plainfeedback.app:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log"]
