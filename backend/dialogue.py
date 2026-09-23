"""Execute the team's JS dialogue reducer and enforce server-owned cart consent."""

import copy
import hashlib
import json
import math
import os
import secrets
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import HTTPException

from backend.ekt_client import EktAPIError
from backend.shop import SHOP

ROOT = Path(__file__).resolve().parent.parent


def reduce_dialogue(state: dict | None, event: dict) -> dict:
    node = shutil.which("node")
    if not node:
        raise HTTPException(503, "Диалог модулі үшін Node.js 20+ орнатыңыз.")
    if state and len(state.get("products", [])) > 30:
        state = copy.deepcopy(state)
        keep = set(state.get("focusIds", [])) | {state.get("pending", {}).get("product_id") if state.get("pending") else None}
        state["products"] = [p for p in state["products"][:-30] if p["id"] in keep] + state["products"][-30:]
    try:
        completed = subprocess.run(
            [node, str(ROOT / "src" / "bridge.js")],
            input=json.dumps({"state": state, "event": event}, ensure_ascii=False),
            capture_output=True, text=True, encoding="utf-8", timeout=8, cwd=ROOT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        result = json.loads(completed.stdout)
        if completed.returncode or not all(k in result for k in ("state", "reply", "requests")):
            raise ValueError("Invalid reducer result")
        return result
    except (subprocess.SubprocessError, OSError, ValueError):
        raise HTTPException(502, "Диалог модулі жауап бере алмады. Кейін қайталаңыз.") from None


@dataclass
class Session:
    id: str
    state: dict | None = None
    cart: dict = field(default_factory=dict)
    pending: dict | None = None
    replay: dict = field(default_factory=dict)
    updated: float = field(default_factory=time.monotonic)
    lock: threading.RLock = field(default_factory=threading.RLock)


SESSIONS: dict[str, Session] = {}
SESSIONS_LOCK = threading.Lock()


def get_session(token: str | None, create: bool = False) -> Session:
    with SESSIONS_LOCK:
        now = time.monotonic()
        for key in list(SESSIONS):
            if now - SESSIONS[key].updated > 3600:
                del SESSIONS[key]
        session = SESSIONS.get(token or "")
        if session is None:
            if not create:
                raise HTTPException(401, "Сессия аяқталды. Бетті жаңартыңыз.")
            if len(SESSIONS) >= 1000:
                raise HTTPException(503, "Сессиялар саны шекке жетті. Кейін қайталаңыз.")
            session = Session(secrets.token_urlsafe(32))
            SESSIONS[session.id] = session
        session.updated = now
        return session


def cart_view(session: Session) -> dict:
    items = [{"product": entry["product"], "quantity": entry["quantity"], "line_total": round(entry["product"]["price"] * entry["quantity"], 2)} for entry in session.cart.values()]
    currencies = {item["product"]["currency"] for item in items}
    currency = next(iter(currencies)) if len(currencies) == 1 else None
    return {"mode": "prototype", "items": items, "total": round(sum(item["line_total"] for item in items), 2) if len(currencies) <= 1 else None, "currency": currency, "cart_url": "/cart"}


def envelope(session: Session, reply: dict, **extra) -> dict:
    return {"reply": reply, "confirmation": session.pending, "cart": cart_view(session), **extra}


def reply(session: Session, message: str, cards: list | None = None) -> dict:
    return {"message": message, "locale": (session.state or {}).get("locale", "kk"), "cards": cards or []}


def once(session: Session, request_id: str, payload: dict, callback) -> dict:
    encoded = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    prior = session.replay.get(request_id)
    if prior:
        if prior[0] != encoded:
            raise HTTPException(409, "Бұл сұраныс идентификаторы басқа әрекет үшін қолданылған.")
        return copy.deepcopy(prior[1])
    result = callback()
    session.replay[request_id] = (encoded, copy.deepcopy(result))
    # A session also limits resource use; old confirmation tokens never become valid again.
    if len(session.replay) > 100:
        del session.replay[next(iter(session.replay))]
    return result


def eligible(product: dict, quantity: int, already: int = 0) -> None:
    if product["stock"] is None or product["price"] is None:
        raise HTTPException(409, "Баға немесе қалдық белгісіз. Себетке қоспас бұрын менеджерден нақтылаңыз.")
    minimum = product.get("minimum_order")
    multiple = product.get("order_multiple")
    if minimum and quantity < minimum:
        raise HTTPException(409, f"API бойынша ең аз саны: {minimum}. Осы санды таңдаңыз.")
    if multiple and quantity % multiple != 0:
        raise HTTPException(409, f"Саны {multiple} еселі болуы керек.")
    if quantity + already > product["stock"]:
        raise HTTPException(409, "Сұралған сан себеттегі санмен бірге қолдағы қалдықтан асады.")


def proposal(session: Session, product_id: int, quantity: int, product: dict | None = None, message: str = "") -> dict:
    product = product or SHOP.detail(product_id)
    already = session.cart.get(product_id, {}).get("quantity", 0)
    eligible(product, quantity, already)
    if session.state is None:
        session.state = reduce_dialogue(None, {"type": "user", "text": "Сәлем"})["state"]
    session.pending = {"id": secrets.token_urlsafe(24), "product_id": product_id, "quantity": quantity, "product": product}
    session.state.update({"phase": "awaiting_confirmation", "pending": {"product_id": product_id, "quantity": quantity}, "request": None, "focusIds": [product_id]})
    session.state["products"] = [p for p in session.state["products"] if p["id"] != product_id] + [product]
    prompt = f"{product['name']}: {quantity} дана тестілік себетке қосылсын ба? Бұл ekt.kz себеті емес."
    return envelope(session, reply(session, (message + "\n" + prompt).strip(), [product]))


def confirm(session: Session, confirmation_id: str | None) -> dict:
    pending = session.pending
    if not pending or not confirmation_id or not secrets.compare_digest(pending["id"], confirmation_id):
        raise HTTPException(409, "Растау ұсынысы жоқ немесе ескірген. Тауар мен санын қайта таңдаңыз.")
    product_id, quantity = pending["product_id"], pending["quantity"]
    fresh = SHOP.detail(product_id)  # Never trust the card's stock or price on mutation.
    already = session.cart.get(product_id, {}).get("quantity", 0)
    if fresh["stock"] is None or fresh["price"] is None:
        session.pending = None
        raise HTTPException(409, "Өзекті баға немесе қалдық расталмады. Тауар қосылмады.")
    available = max(0, math.floor(fresh["stock"]) - already)
    if available < quantity:
        session.pending = None
        if available > 0:
            return proposal(session, product_id, available, fresh, "Қалдық өзгерді. Жаңа санды қайта растаңыз.")
        session.state.update({"phase": "idle", "pending": None, "request": None})
        return envelope(session, reply(session, "Бұл тауардан қосуға қалдық жоқ. Тауар қосылмады; балама сұрай аласыз.", [fresh]))
    if any(fresh.get(key) != pending["product"].get(key) for key in ("price", "currency", "minimum_order", "order_multiple")):
        session.pending = None
        return proposal(session, product_id, quantity, fresh, "Баға немесе сатып алу шарты өзгерді. Жаңа ұсынысты қайта растаңыз.")
    eligible(fresh, quantity, already)
    # Exercise the same reducer flow used by chat; Python alone authorizes mutation.
    checked = reduce_dialogue(session.state, {"type": "user", "text": "Иә, себетке қос"})
    requests = checked["requests"]
    if not requests or requests[0].get("action") != "check_stock":
        raise HTTPException(409, "Диалогтағы растау ескірген. Жаңа ұсыныс жасаңыз.")
    action = requests[0]
    adding = reduce_dialogue(checked["state"], {"type": "server", "action_result": {**action, "status": "ok"}})
    requests = adding["requests"]
    if not requests or requests[0].get("action") != "add_to_cart" or requests[0].get("product_id") != product_id or requests[0].get("quantity") != quantity:
        raise HTTPException(409, "Себет әрекеті расталған ұсынысқа сәйкес емес.")
    # This is deliberately an isolated prototype cart, never an external order.
    finished = reduce_dialogue(adding["state"], {"type": "server", "action_result": {**requests[0], "status": "ok"}, "links": {"cart_url": "/cart"}})
    session.cart[product_id] = {"product": fresh, "quantity": already + quantity}
    session.state, session.pending = finished["state"], None
    return envelope(session, reply(session, "Тауар тестілік себетке қосылды. Нақты ekt.kz тапсырысы жасалған жоқ." ) | {"links": {"cart_url": "/cart"}})


def purchase_terms(session: Session) -> dict:
    path = ROOT / "backend" / "purchase_terms.json"
    terms = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    result = {}
    for key in ("payment", "delivery", "minimum_order"):
        entry = terms.get(key)
        if isinstance(entry, dict) and entry.get("text") and entry.get("source_url"):
            result[key] = f"{entry['text']} Дереккөз: {entry['source_url']}"
    focused = (session.state or {}).get("focusIds", [])
    if len(focused) == 1:
        product = SHOP.detail(focused[0])
        if product["minimum_order"]:
            result["minimum_order"] = f"Осы тауардың API-дегі KRATNOST_MIN мәні: {product['minimum_order']}. Тапсырыстың жалпы ең аз сомасы көрсетілмеген."
    return result


def chat(session: Session, message: str, confirmation_id: str | None = None) -> dict:
    previous = copy.deepcopy(session.state)
    result = reduce_dialogue(session.state, {"type": "user", "text": message})
    if result["requests"] and result["requests"][0]["action"] == "check_stock":
        return confirm(session, confirmation_id)
    session.pending = None
    coverage = None
    for _ in range(6):
        session.state = result["state"]
        if not result["requests"]:
            break
        action = result["requests"][0]
        kind = action["action"]
        event = {"type": "server", "action_result": {"request_id": action["request_id"], "action": kind, "status": "ok"}}
        try:
            if kind == "search":
                found = SHOP.search(action["query"])
                event["products"], coverage = found["items"], found["coverage"]
            elif kind == "get_product_info":
                event["products"] = [SHOP.detail(action["product_id"])]
            elif kind == "get_alternatives":
                event["products"] = SHOP.alternatives(action.get("product_id"), action.get("query", ""))
            elif kind == "get_purchase_terms":
                event["purchase_terms"] = purchase_terms(session)
            else:
                raise HTTPException(409, "Бұл әрекетке нақты растау қажет.")
        except EktAPIError:
            session.state = previous
            raise
        result = reduce_dialogue(session.state, event)
    else:
        raise HTTPException(502, "Диалог сұранысы тым көп қадам талап етті. Сұрақты нақтылаңыз.")
    session.state = result["state"]
    if session.state.get("phase") == "awaiting_confirmation" and session.state.get("pending"):
        pending = session.state["pending"]
        return proposal(session, pending["product_id"], pending["quantity"])
    if coverage and not coverage["complete"]:
        result["reply"]["message"] += f"\nІздеу каталогтың алғашқы {coverage['max_pages']} бетімен шектелген; толық каталог тексерілген жоқ."
    return envelope(session, result["reply"], catalog_coverage=coverage)
