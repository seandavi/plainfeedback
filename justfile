default:
    @just --list

dev:
    uv run uvicorn plainfeedback.app:app --reload --no-access-log

test:
    uv run pytest

lint:
    uv run ruff check . && uv run ruff format --check .

typecheck:
    uv run pyright

up:
    docker compose up --build -d

down:
    docker compose down
