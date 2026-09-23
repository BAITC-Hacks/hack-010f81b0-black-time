"""Offline API checks. Every upstream payload and credential is synthetic."""

import json
import secrets
from unittest.mock import Mock

import pytest
import requests
from fastapi.testclient import TestClient
from requests.auth import HTTPBasicAuth
from urllib3.exceptions import ReadTimeoutError

from backend.main import app


CATALOG_ROUTES = ("/products", "/products/515291")
LOCAL_ORIGINS = (
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)


@pytest.fixture(autouse=True)
def synthetic_credentials(monkeypatch):
    """Never consume the developer's real environment or .env credentials."""
    credentials = ("synthetic-test-login", "synthetic-test-" + secrets.token_urlsafe(24))
    monkeypatch.setenv("EKT_LOGIN", credentials[0])
    monkeypatch.setenv("EKT_PASSWORD", credentials[1])
    return credentials


@pytest.fixture(autouse=True)
def upstream_get(monkeypatch):
    """An unplanned upstream call fails locally instead of using the network."""
    get = Mock(side_effect=AssertionError("Unexpected upstream request in an offline test"))
    monkeypatch.setattr(requests, "get", get)

    def block_network(*args, **kwargs):
        raise AssertionError("Real Requests network access is forbidden in these tests")

    monkeypatch.setattr(requests.sessions.Session, "send", block_network)
    return get


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


def upstream_response(payload=None, *, status=200, raw_body=None):
    """Build a Requests response containing only fabricated test data."""
    response = requests.Response()
    response.status_code = status
    response.url = "https://ekt.kz/api/products"
    response.encoding = "utf-8"
    if raw_body is None:
        response._content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        response.headers["Content-Type"] = "application/json"
    else:
        response._content = raw_body.encode("utf-8")
        response.headers["Content-Type"] = "text/html"
    return response


def return_upstream(upstream_get, response):
    upstream_get.side_effect = None
    upstream_get.return_value = response


def assert_safe_error(response, status, credentials):
    assert response.status_code == status
    body = response.json()
    assert isinstance(body.get("detail"), str)
    assert body["detail"].strip()
    for sensitive_value in (*credentials, "Authorization", "Traceback", "<html", "synthetic-upstream-body"):
        assert sensitive_value.lower() not in response.text.lower()


def test_health_without_credentials_does_not_call_upstream(client, monkeypatch, upstream_get):
    monkeypatch.delenv("EKT_LOGIN")
    monkeypatch.delenv("EKT_PASSWORD")

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    upstream_get.assert_not_called()


@pytest.mark.parametrize("query,page", [("", 1), ("?page=1", 1), ("?page=2", 2)])
def test_catalog_page_and_request_security(client, upstream_get, synthetic_credentials, query, page):
    payload = {"synthetic_fixture": True, "opaque_items": [{"value": None}], "next": "unknown"}
    return_upstream(upstream_get, upstream_response(payload))

    response = client.get("/products" + query)

    assert response.status_code == 200
    assert response.json() == {"source": "ekt.kz", "data": payload}
    upstream_get.assert_called_once_with(
        "https://ekt.kz/api/products",
        params={"page": page},
        auth=HTTPBasicAuth(*synthetic_credentials),
        timeout=(5, 15),
        allow_redirects=False,
        verify=True,
    )


def test_product_id_is_forwarded_as_id(client, upstream_get, synthetic_credentials):
    payload = {"synthetic_fixture": True, "opaque_metadata": {"arbitrary": [None, "үлгі"]}}
    return_upstream(upstream_get, upstream_response(payload))

    response = client.get("/products/515291")

    assert response.status_code == 200
    assert response.json() == {"source": "ekt.kz", "data": payload}
    upstream_get.assert_called_once_with(
        "https://ekt.kz/api/products/detail",
        params={"id": 515291},
        auth=HTTPBasicAuth(*synthetic_credentials),
        timeout=(5, 15),
        allow_redirects=False,
        verify=True,
    )


@pytest.mark.parametrize("route", CATALOG_ROUTES)
@pytest.mark.parametrize(
    "payload",
    [
        {"synthetic_fixture": True, "unknown": [None, {}, [], {"text": "жасанды үлгі"}]},
        [None, 0, "synthetic-record"],
        None,
        "synthetic-text",
        17,
        2.5,
        False,
    ],
)
def test_arbitrary_upstream_json_is_preserved(client, upstream_get, route, payload):
    return_upstream(upstream_get, upstream_response(payload))

    response = client.get(route)

    assert response.status_code == 200
    assert response.json() == {"source": "ekt.kz", "data": payload}
    upstream_get.assert_called_once()


@pytest.mark.parametrize("page", ["0", "-1", "1.5", "abc", "", "true"])
def test_invalid_page_never_calls_upstream(client, upstream_get, page):
    response = client.get("/products", params={"page": page})

    assert response.status_code == 422
    upstream_get.assert_not_called()


@pytest.mark.parametrize("product_id", ["0", "-1", "1.5", "abc", "true"])
def test_invalid_product_id_never_calls_upstream(client, upstream_get, product_id):
    response = client.get("/products/" + product_id)

    assert response.status_code == 422
    upstream_get.assert_not_called()


@pytest.mark.parametrize("route", CATALOG_ROUTES)
@pytest.mark.parametrize("variable", ["EKT_LOGIN", "EKT_PASSWORD"])
@pytest.mark.parametrize("value", [None, ""])
def test_unconfigured_credentials_return_503(
    client, monkeypatch, upstream_get, synthetic_credentials, route, variable, value
):
    if value is None:
        monkeypatch.delenv(variable)
    else:
        monkeypatch.setenv(variable, value)

    response = client.get(route)

    assert_safe_error(response, 503, synthetic_credentials)
    upstream_get.assert_not_called()


@pytest.mark.parametrize("route", CATALOG_ROUTES)
@pytest.mark.parametrize("exception_class", [requests.ConnectTimeout, requests.ReadTimeout])
def test_upstream_timeouts_return_safe_504(
    client, upstream_get, synthetic_credentials, route, exception_class
):
    upstream_get.side_effect = exception_class(
        "Authorization: " + synthetic_credentials[1] + " synthetic-upstream-body"
    )

    response = client.get(route)

    assert_safe_error(response, 504, synthetic_credentials)
    upstream_get.assert_called_once()


@pytest.mark.parametrize("route", CATALOG_ROUTES)
def test_response_body_timeout_wrapped_by_requests_returns_504(
    client, upstream_get, synthetic_credentials, route
):
    upstream_get.side_effect = requests.ConnectionError(
        ReadTimeoutError(None, "synthetic-url", "synthetic timeout")
    )

    response = client.get(route)

    assert_safe_error(response, 504, synthetic_credentials)
    upstream_get.assert_called_once()


@pytest.mark.parametrize("route", CATALOG_ROUTES)
@pytest.mark.parametrize("exception_class", [requests.ConnectionError, requests.RequestException])
def test_upstream_connection_errors_return_safe_502(
    client, upstream_get, synthetic_credentials, route, exception_class
):
    upstream_get.side_effect = exception_class(
        "Authorization: " + synthetic_credentials[1] + " synthetic-upstream-body"
    )

    response = client.get(route)

    assert_safe_error(response, 502, synthetic_credentials)
    upstream_get.assert_called_once()


@pytest.mark.parametrize("route", CATALOG_ROUTES)
@pytest.mark.parametrize("upstream_status", [301, 302, 307, 401, 403, 404, 429, 500, 503])
def test_upstream_http_errors_return_safe_502(
    client, upstream_get, synthetic_credentials, route, upstream_status
):
    raw_body = "<html>synthetic-upstream-body Authorization: " + synthetic_credentials[1] + "</html>"
    upstream = upstream_response(status=upstream_status, raw_body=raw_body)
    upstream.headers["Location"] = "https://untrusted.example.invalid/synthetic-redirect"
    return_upstream(upstream_get, upstream)

    response = client.get(route)

    assert_safe_error(response, 502, synthetic_credentials)
    upstream_get.assert_called_once()
    assert upstream_get.call_args.kwargs["allow_redirects"] is False


@pytest.mark.parametrize("route", CATALOG_ROUTES)
@pytest.mark.parametrize(
    "raw_body",
    [
        "<html>synthetic-upstream-body</html>",
        "",
        '{"synthetic_fixture":',
        "NaN",
        "Infinity",
        "-Infinity",
        '{"synthetic_fixture":NaN}',
        "1e400",
    ],
)
def test_invalid_upstream_json_returns_safe_502(
    client, upstream_get, synthetic_credentials, route, raw_body
):
    return_upstream(upstream_get, upstream_response(raw_body=raw_body))

    response = client.get(route)

    assert_safe_error(response, 502, synthetic_credentials)
    upstream_get.assert_called_once()


@pytest.mark.parametrize("origin", LOCAL_ORIGINS)
def test_local_frontend_cors_preflight(client, upstream_get, origin):
    response = client.options(
        "/products",
        headers={"Origin": origin, "Access-Control-Request-Method": "GET"},
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin
    assert "GET" in response.headers["access-control-allow-methods"]
    upstream_get.assert_not_called()


def test_unlisted_origin_is_not_allowed(client, upstream_get):
    response = client.options(
        "/products",
        headers={
            "Origin": "https://untrusted.example.invalid",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers
    upstream_get.assert_not_called()
