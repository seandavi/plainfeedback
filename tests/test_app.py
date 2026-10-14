import logging

from fastapi import Response
from fastapi.testclient import TestClient

from plainfeedback.app import create_app

HEADERS = {"user-agent": "SecretAgent/9.9", "cookie": "a=b"}


def test_healthz():
    assert TestClient(create_app()).get("/healthz").json() == {"status": "ok"}


def test_participant_routes_set_no_cookies():
    app = create_app()

    @app.get("/s/leak/cookie")  # simulates a future bug/lib setting a cookie
    def leak(response: Response):
        response.set_cookie("sid", "x")
        return {}

    client = TestClient(app)
    for path in ("/s/ev/sv", "/s/leak/cookie", "/api/v1/public/surveys/1"):
        r = client.get(path, headers=HEADERS)
        assert r.status_code == 200
        assert "set-cookie" not in r.headers, path


def test_access_log_omits_ip_and_user_agent(caplog):
    caplog.set_level(logging.INFO)
    client = TestClient(create_app(), client=("203.0.113.7", 1234))
    client.get("/s/ev/sv", headers=HEADERS)
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert "/s/ev/sv" in text
    assert "203.0.113.7" not in text and "SecretAgent" not in text
