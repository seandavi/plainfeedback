import logging

from fastapi import APIRouter, FastAPI, Request, Response

PARTICIPANT_PREFIXES = ("/s/", "/api/v1/public/")

# Own access log: method, path, status only. No client IP, no user-agent.
# Run uvicorn with --no-access-log (its format includes the client address).
access_log = logging.getLogger("plainfeedback.access")

participant = APIRouter()


@participant.get("/s/{event}/{survey}")
def participant_page(event: str, survey: str) -> dict[str, str]:
    return {"event": event, "survey": survey}  # stub


public_api = APIRouter(prefix="/api/v1/public")


@public_api.get("/surveys/{survey_id}")
def public_survey(survey_id: str) -> dict[str, str]:
    return {"id": survey_id}  # stub


def create_app() -> FastAPI:
    app = FastAPI(title="plainfeedback")
    app.include_router(participant)
    app.include_router(public_api)

    @app.middleware("http")
    async def participant_invariants(request: Request, call_next) -> Response:
        response: Response = await call_next(request)
        if request.url.path.startswith(PARTICIPANT_PREFIXES):
            del response.headers["set-cookie"]  # removes all Set-Cookie headers
            response.headers["Cache-Control"] = "no-store"
        access_log.info("%s %s %s", request.method, request.url.path, response.status_code)
        return response

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
