"""Offline HTTP acceptance checks for the connected chat and prototype cart.

The real Node dialogue bridge is exercised; the shop upstream is always fake.
No test uses developer credentials or permits a Requests network call.
"""

from copy import deepcopy
from uuid import uuid4

import pytest
import requests
from fastapi.testclient import TestClient

from backend import ekt_client
from backend.main import app


PRODUCT_ID = 515291
OTHER_ID = 515292


def request_id():
    return str(uuid4())


@pytest.mark.parametrize("compatible", [True, False])
def test_unavailable_product_gets_only_evidence_matched_alternative(client, catalog, compatible):
    records, _ = catalog
    facts = {"OBYEM": "Автоматический выключатель", "NOMINALNYY_TOK": "16 А", "KOLICHESTVO_POLYUSOV": "1", "NOMINALNOE_NAPRYAZHENIE": "230 В"}
    records[PRODUCT_ID].update(name="TEST breaker C16", quantity=0, properties=deepcopy(facts))
    records[OTHER_ID].update(name="TEST breaker C16 alternative", quantity=5, properties={**facts, "NOMINALNYY_TOK": "16А" if compatible else "32А"})
    response = client.post("/api/chat", json={"message": f"id {PRODUCT_ID}", "request_id": request_id()})
    assert response.status_code == 200, response.text
    payload = response.json()
    if compatible:
        assert [p["id"] for p in payload["reply"]["cards"]] == [OTHER_ID]
        assert "16" in payload["reply"]["message"]
    else:
        assert not payload["reply"]["cards"]
        assert payload["reply"].get("handoff") is True
    assert payload["confirmation"] is None
    assert payload["cart"]["items"] == []


def product(product_id=PRODUCT_ID, **changes):
    value = {
        "id": product_id,
        "name": "Кабель TEST-A 3x2.5",
        "article": "TEST-ARTICLE-A",
        "description": "Синтетикалық тест тауар. Кабель 3x2.5.",
        "price": 1500,
        "quantity": 12,
        "stores": [{"id": 13, "name": "Тест қоймасы", "quantity": 12}],
        "image": None,
        "url": "https://ekt.kz/catalog/test-product/",
        "offers": [],
        "properties": {
            "KRATNOST_MIN": "1",
            "TORGOVAYA_MARKA": "TestBrand",
            "OBYEM": "Кабель",
            "SECHENIE": "3x2.5",
        },
    }
    value.update(changes)
    return value


@pytest.fixture(autouse=True)
def forbid_network(monkeypatch):
    def blocked(*args, **kwargs):
        raise AssertionError("Network access is forbidden in offline integration tests")

    monkeypatch.setattr(requests, "get", blocked)
    monkeypatch.setattr(requests.sessions.Session, "send", blocked)
    monkeypatch.setenv("EKT_LOGIN", "synthetic-integration-login")
    monkeypatch.setenv("EKT_PASSWORD", "synthetic-integration-password")
    monkeypatch.delenv("CATALOG_CURRENCY", raising=False)


@pytest.fixture
def catalog(monkeypatch):
    """Mutable details allow a real proposal/confirmation stock race."""
    from backend.shop import SHOP

    records = {PRODUCT_ID: product()}
    records.update({
        610000 + index: product(
            610000 + index,
            name=f"Сынақ шамы {index}",
            article=f"LAMP-{index}",
            properties={"KRATNOST_MIN": "1", "OBYEM": "Шам"},
        )
        for index in range(19)
    })
    records[OTHER_ID] = product(
        OTHER_ID, name="Кабель TEST-B 3x2.5", article="PAGE-TWO-ARTICLE", price=1200
    )
    observed = {"pages": [], "details": []}

    def fake_list(page):
        observed["pages"].append(page)
        values = list(records.values())
        items = values[(page - 1) * 20:page * 20]
        return {
            "page": page, "per_page": 20, "count": len(items),
            "items": deepcopy(items),
        }

    def fake_detail(product_id):
        observed["details"].append(product_id)
        if int(product_id) not in records:
            raise ekt_client.EktAPIError(404, "Тест тауары табылмады.")
        return deepcopy(records[int(product_id)])

    monkeypatch.setattr(ekt_client, "get_products", fake_list)
    monkeypatch.setattr(ekt_client, "get_product", fake_detail)
    SHOP.clear_cache()
    yield records, observed
    SHOP.clear_cache()


@pytest.fixture
def client(catalog):
    with TestClient(app) as session:
        response = session.get("/api/session")
        assert response.status_code == 200
        yield session


def post(client, route, **payload):
    payload.setdefault("request_id", request_id())
    return client.post(route, json=payload)


def propose(client, quantity=3, product_id=PRODUCT_ID):
    response = post(
        client, "/api/cart/proposal", product_id=product_id, quantity=quantity
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["confirmation"] is not None
    return body


def confirm(client, token, **extra):
    return post(client, "/api/cart/confirm", confirmation_id=token, **extra)


def current_cart(client):
    response = client.get("/api/cart")
    assert response.status_code == 200
    return response.json()


def assert_empty_cart(client):
    assert current_cart(client)["items"] == []


def test_session_announces_prototype_rules_and_unknown_currency(client):
    response = client.get("/api/session")
    data = response.json()
    assert data["session_id"]
    assert data["cart_mode"] == "prototype"
    assert data["ai_mode"] == "rules"
    assert data["catalog_currency"] is None
    assert data["capabilities"]
    cookies = response.headers.get_list("set-cookie")
    if not cookies:
        with TestClient(app) as fresh:
            cookies = fresh.get("/api/session").headers.get_list("set-cookie")
    assert cookies
    assert all("httponly" in cookie.lower() for cookie in cookies)
    assert all("samesite=" in cookie.lower() for cookie in cookies)


def test_search_reaches_second_page_and_reports_coverage(client, catalog):
    response = client.get("/api/search", params={"q": "PAGE-TWO-ARTICLE"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert str(OTHER_ID) in {str(item["id"]) for item in body["items"]}
    assert 2 in catalog[1]["pages"]
    assert body["coverage"]["pages_loaded"] >= 2
    assert isinstance(body["coverage"]["complete"], bool)
    assert body["coverage"]["max_pages"] >= body["coverage"]["pages_loaded"]


def test_chat_product_id_and_followup_use_real_bridge(client, catalog):
    response = post(client, "/api/chat", message=f"ID {PRODUCT_ID}")
    assert response.status_code == 200, response.text
    body = response.json()
    cards = body["reply"]["cards"]
    assert str(PRODUCT_ID) in {str(item["id"]) for item in cards}
    assert str(PRODUCT_ID) in {str(value) for value in catalog[1]["details"]}
    assert body["confirmation"] is None
    assert_empty_cart(client)

    response = post(client, "/api/chat", message="одан 5 дана қос")
    assert response.status_code == 200, response.text
    pending = response.json()["confirmation"]
    assert str(pending["product_id"]) == str(PRODUCT_ID)
    assert pending["quantity"] == 5
    assert_empty_cart(client)


def test_proposal_only_then_confirmation_adds_exact_item_and_link(client):
    body = propose(client, quantity=3)
    pending = body["confirmation"]
    assert str(pending["product_id"]) == str(PRODUCT_ID)
    assert pending["quantity"] == 3
    assert_empty_cart(client)

    response = confirm(client, pending["id"])
    assert response.status_code == 200, response.text
    cart = response.json()["cart"]
    assert cart["mode"] == "prototype"
    assert cart["currency"] is None
    assert len(cart["items"]) == 1
    assert str(cart["items"][0]["product"]["id"]) == str(PRODUCT_ID)
    assert cart["items"][0]["quantity"] == 3
    assert cart["items"][0]["line_total"] == 4500
    assert cart["total"] == 4500
    assert cart["cart_url"] == "/cart"
    assert client.get(cart["cart_url"]).status_code == 200
    assert current_cart(client)["items"] == cart["items"]


def test_unknown_confirmation_does_not_add(client):
    response = confirm(client, request_id())
    assert response.status_code == 409
    assert_empty_cart(client)


def test_confirm_requires_token(client):
    propose(client)
    response = post(client, "/api/cart/confirm")
    assert response.status_code in (409, 422)
    assert_empty_cart(client)


def test_replayed_request_is_idempotent_and_consumed_token_rejected(client):
    token = propose(client)["confirmation"]["id"]
    transaction = request_id()
    response = confirm(client, token, request_id=transaction)
    assert response.status_code == 200
    repeated = confirm(client, token, request_id=transaction)
    assert repeated.status_code in (200, 409)
    assert current_cart(client)["items"][0]["quantity"] == 3
    assert confirm(client, token).status_code == 409
    assert current_cart(client)["items"][0]["quantity"] == 3


def test_session_cannot_use_another_users_confirmation(client):
    token = propose(client)["confirmation"]["id"]
    with TestClient(app) as another:
        another.get("/api/session")
        assert confirm(another, token).status_code == 409
        assert_empty_cart(another)
    assert_empty_cart(client)
    assert confirm(client, token).status_code == 200


def test_cancel_and_replacement_invalidate_previous_confirmation(client):
    first = propose(client)["confirmation"]["id"]
    second = propose(client, quantity=4)["confirmation"]["id"]
    assert second != first
    assert confirm(client, first).status_code == 409
    response = client.post("/api/cart/cancel", json={})
    assert response.status_code == 200
    assert confirm(client, second).status_code == 409
    assert_empty_cart(client)


def test_stock_drop_requires_new_confirmation_and_no_silent_add(client, catalog):
    original = propose(client, quantity=5)["confirmation"]
    catalog[0][PRODUCT_ID]["quantity"] = 2
    catalog[0][PRODUCT_ID]["stores"][0]["quantity"] = 2
    response = confirm(client, original["id"])
    assert response.status_code == 200, response.text
    replacement = response.json()["confirmation"]
    assert replacement is not None
    assert replacement["id"] != original["id"]
    assert replacement["quantity"] == 2
    assert_empty_cart(client)
    assert confirm(client, original["id"]).status_code == 409
    assert confirm(client, replacement["id"]).status_code == 200
    assert current_cart(client)["items"][0]["quantity"] == 2


def test_price_change_requires_new_confirmation(client, catalog):
    original = propose(client, quantity=3)["confirmation"]
    catalog[0][PRODUCT_ID]["price"] = 1700
    response = confirm(client, original["id"])
    assert response.status_code == 200, response.text
    replacement = response.json()["confirmation"]
    assert replacement["id"] != original["id"]
    assert replacement["product"]["price"] == 1700
    assert replacement["quantity"] == 3
    assert_empty_cart(client)
    assert confirm(client, replacement["id"]).status_code == 200
    assert current_cart(client)["total"] == 5100


def test_cumulative_quantity_never_exceeds_stock(client):
    first = propose(client, quantity=10)["confirmation"]
    assert confirm(client, first["id"]).status_code == 200
    response = post(client, "/api/cart/proposal", product_id=PRODUCT_ID, quantity=5)
    assert response.status_code in (200, 409, 422), response.text
    if response.status_code == 200:
        pending = response.json()["confirmation"]
        if pending:
            result = confirm(client, pending["id"])
            assert result.status_code in (200, 409)
    assert current_cart(client)["items"][0]["quantity"] <= 12


@pytest.mark.parametrize("quantity", [0, -1, 1.5, True, 1000000000])
def test_invalid_quantities_never_mutate_cart(client, quantity):
    response = post(client, "/api/cart/proposal", product_id=PRODUCT_ID, quantity=quantity)
    assert response.status_code in (409, 422)
    assert_empty_cart(client)


@pytest.mark.parametrize("missing_field", ["price", "quantity"])
def test_unknown_price_or_stock_cannot_be_confirmed(client, catalog, missing_field):
    catalog[0][PRODUCT_ID][missing_field] = None
    if missing_field == "quantity":
        catalog[0][PRODUCT_ID]["stores"] = []
    response = post(client, "/api/cart/proposal", product_id=PRODUCT_ID, quantity=2)
    assert response.status_code in (409, 422), response.text
    assert_empty_cart(client)


def test_wrong_detail_id_cannot_put_a_different_product_in_cart(client, catalog):
    catalog[0][PRODUCT_ID]["id"] = OTHER_ID
    response = post(client, "/api/cart/proposal", product_id=PRODUCT_ID, quantity=2)
    assert response.status_code in (409, 422, 502), response.text
    assert_empty_cart(client)


def test_untrusted_origin_cannot_change_session_cart(client):
    response = client.post(
        "/api/cart/proposal",
        json={"product_id": PRODUCT_ID, "quantity": 2, "request_id": request_id()},
        headers={"Origin": "https://evil.test"},
    )
    assert response.status_code == 403
    assert_empty_cart(client)


def test_cart_removal_is_session_scoped(client):
    token = propose(client)["confirmation"]["id"]
    assert confirm(client, token).status_code == 200
    with TestClient(app) as another:
        another.get("/api/session")
        another.delete(f"/api/cart/items/{PRODUCT_ID}")
        assert_empty_cart(another)
    assert current_cart(client)["items"][0]["quantity"] == 3
    assert client.delete(f"/api/cart/items/{PRODUCT_ID}").status_code == 200
    assert_empty_cart(client)


def test_payment_number_is_neither_echoed_nor_retained_in_replay_history(client):
    from backend.dialogue import get_session

    sensitive = "4111 1111 1111 1111"
    transaction = request_id()
    response = post(client, "/api/chat", message=sensitive, request_id=transaction)
    assert response.status_code == 200, response.text
    repeated = post(client, "/api/chat", message=sensitive, request_id=transaction)
    assert repeated.status_code == 200
    assert repeated.json() == response.json()

    session = get_session(client.cookies.get("ekt_session"))
    retained = repr((session.state, session.pending, session.cart, session.replay))
    for value in (sensitive, sensitive.replace(" ", "")):
        assert value not in response.text
        assert value not in repeated.text
        assert value not in retained
    assert_empty_cart(client)

    mismatched = post(client, "/api/chat", message="сәлем", request_id=transaction)
    assert mismatched.status_code == 409
