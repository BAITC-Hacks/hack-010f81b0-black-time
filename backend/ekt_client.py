"""Small synchronous client for the two supported ekt.kz catalog endpoints."""

import math
import os
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from requests.auth import HTTPBasicAuth
from urllib3.exceptions import ReadTimeoutError


# Always use the repository's .env; existing process variables take precedence.
load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)

API_BASE_URL = "https://ekt.kz/api/products"
REQUEST_TIMEOUT = (5, 15)


class EktAPIError(Exception):
    """An upstream/configuration error safe to expose through our API."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _parse_finite_number(value: str) -> float:
    # Python's JSON decoder accepts NaN/Infinity, which cannot be returned as JSON.
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("Non-finite JSON number")
    return number


def _get_json(url: str, params: dict[str, int]) -> Any:
    login = os.getenv("EKT_LOGIN")
    password = os.getenv("EKT_PASSWORD")
    if not login or not password:
        raise EktAPIError(
            503,
            "ekt.kz кіру деректері бапталмаған. Сервердегі EKT_LOGIN және "
            "EKT_PASSWORD орта айнымалыларын тексеріңіз.",
        )

    try:
        response = requests.get(
            url,
            params=params,
            auth=HTTPBasicAuth(login, password),
            timeout=REQUEST_TIMEOUT,
            allow_redirects=False,
            verify=True,
        )
    except requests.Timeout:
        raise EktAPIError(504, "ekt.kz API-іне қосылу немесе жауап күту уақыты бітті.") from None
    except requests.ConnectionError as exc:
        # Requests wraps timeouts while downloading the body in ConnectionError.
        if any(isinstance(reason, ReadTimeoutError) for reason in exc.args):
            raise EktAPIError(504, "ekt.kz API-іне қосылу немесе жауап күту уақыты бітті.") from None
        raise EktAPIError(502, "ekt.kz API-іне қосылу немесе жауапты алу қатесі.") from None
    except requests.RequestException:
        raise EktAPIError(502, "ekt.kz API-іне қосылу немесе жауапты алу қатесі.") from None

    if response.status_code in (401, 403):
        raise EktAPIError(
            502,
            "ekt.kz API-і кіруге рұқсат бермеді. Сервердің ekt.kz-ке кіру "
            "деректерін (EKT_LOGIN, EKT_PASSWORD) тексеріңіз.",
        )
    if 300 <= response.status_code < 400:
        raise EktAPIError(502, "ekt.kz API-і күтпеген redirect қайтарды; сұраныс жалғастырылмады.")
    if not 200 <= response.status_code < 300:
        raise EktAPIError(502, f"ekt.kz API-і HTTP {response.status_code} қатесін қайтарды.")

    try:
        return response.json(parse_constant=_parse_finite_number, parse_float=_parse_finite_number)
    except ValueError:
        raise EktAPIError(502, "ekt.kz API-і жарамды JSON қайтармады.") from None


def get_products(page: int) -> Any:
    """Fetch exactly one page without assuming the upstream JSON schema."""
    return _get_json(API_BASE_URL, {"page": page})


def get_product(product_id: int) -> Any:
    """Fetch by product ID, which is distinct from an article number."""
    return _get_json(f"{API_BASE_URL}/detail", {"id": product_id})
