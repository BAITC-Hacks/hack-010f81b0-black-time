"""Opt-in local integration check. Reads EKT data; mutates ONLY the prototype cart."""

import json
import time
from uuid import uuid4

import requests

BASE = "http://127.0.0.1:8000"


def main():
    started = time.monotonic()
    with requests.Session() as client:
        client.trust_env = False

        def call(method, path, payload=None):
            response = client.request(method, BASE + path, json=payload, timeout=(3, 60))
            if response.status_code != 200:
                raise RuntimeError(f"{path}: HTTP {response.status_code}")
            return response.json()

        assert call("GET", "/health") == {"status": "ok"}
        session = call("GET", "/api/session")
        assert session["cart_mode"] == "prototype", "Only the test cart may be changed by this check"
        chat = call("POST", "/api/chat", {"message": "id 515291", "request_id": str(uuid4())})
        product = next(p for p in chat["reply"]["cards"] if p["id"] == 515291)
        amount = max(1, int(product.get("minimum_order") or 1))
        draft = call("POST", "/api/cart/proposal", {"product_id": product["id"], "quantity": amount, "request_id": str(uuid4())})
        assert not draft["cart"]["items"]
        confirmation = {"confirmation_id": draft["confirmation"]["id"], "request_id": str(uuid4())}
        added = call("POST", "/api/cart/confirm", confirmation)
        assert added["cart"]["items"][0]["quantity"] == amount
        call("POST", "/api/cart/confirm", confirmation)
        cart = call("GET", "/api/cart")
        assert cart["items"][0]["quantity"] == amount
        assert cart["cart_url"] == "/cart"
        found = call("GET", "/api/search?q=200300285_")
        assert any(p["id"] == 515291 for p in found["items"])
        terms = call("POST", "/api/chat", {"message": "Жеткізу туралы", "request_id": str(uuid4())})
        assert "https://ekt.kz/include/ses.php" in terms["reply"]["message"]
        print(json.dumps({"health": "ok", "live_product_id": product["id"], "sku_search": "ok", "sourced_terms": "ok", "ai_mode": session["ai_mode"], "confirmation_required": True, "retry_did_not_duplicate": True, "cart_mode": cart["mode"], "external_cart_changed": False, "elapsed_seconds": round(time.monotonic() - started, 2)}))


if __name__ == "__main__":
    main()
