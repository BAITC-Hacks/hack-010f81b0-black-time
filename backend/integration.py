"""Same-origin UI, server-owned sessions, chat, and an explicitly prototype cart."""

import os
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, File, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, ConfigDict, Field

from backend import dialogue
from backend.attachments import extract_attachment
from backend.shop import SHOP

router = APIRouter(prefix="/api")
COOKIE = "ekt_session"
ALLOWED_ORIGINS = {f"http://{host}:{port}" for host in ("127.0.0.1", "localhost") for port in (8000, 5500, 5173)}


def session(request: Request) -> dialogue.Session:
    origin = request.headers.get("origin")
    if request.method not in ("GET", "HEAD", "OPTIONS") and origin and origin not in ALLOWED_ORIGINS:
        raise HTTPException(403, "Бұл origin үшін әрекетке рұқсат жоқ.")
    return dialogue.get_session(request.cookies.get(COOKIE))


class ChatInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: str = Field(min_length=1, max_length=12000)
    request_id: str = Field(min_length=8, max_length=100)
    confirmation_id: str | None = Field(default=None, max_length=100)


class ProposalInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    product_id: int = Field(gt=0, strict=True)
    quantity: int = Field(gt=0, le=1000000, strict=True)
    request_id: str = Field(min_length=8, max_length=100)


class ConfirmInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirmation_id: str = Field(min_length=1, max_length=100)
    request_id: str = Field(min_length=8, max_length=100)


@router.get("/session")
def start_session(request: Request, response: Response):
    current = dialogue.get_session(request.cookies.get(COOKIE), create=True)
    response.set_cookie(COOKIE, current.id, httponly=True, samesite="strict", secure=request.url.scheme == "https", max_age=3600)
    response.headers["Cache-Control"] = "no-store"
    return {"session_id": current.id, "cart_mode": "prototype", "ai_mode": "rules", "catalog_currency": os.getenv("CATALOG_CURRENCY") or None, "capabilities": {"attachments": ["xlsx", "xls", "docx", "pdf", "jpg", "jpeg"], "real_ekt_cart": False, "max_upload_bytes": 10 * 1024 * 1024, "catalog_max_pages": SHOP.max_pages}}


@router.post("/chat")
def send_chat(body: ChatInput, current: Annotated[dialogue.Session, Depends(session)]):
    with current.lock:
        return dialogue.once(current, body.request_id, {"action": "chat", **body.model_dump()}, lambda: dialogue.chat(current, body.message, body.confirmation_id))


@router.get("/search")
def search(q: str = ""):
    if not q.strip() or len(q) > 500:
        raise HTTPException(422, "Іздеу сұрауы 1–500 таңба болуы керек.")
    return SHOP.search(q)


@router.get("/cart")
def get_cart(current: Annotated[dialogue.Session, Depends(session)]):
    with current.lock:
        return dialogue.cart_view(current)


@router.post("/cart/proposal")
def propose(body: ProposalInput, current: Annotated[dialogue.Session, Depends(session)]):
    with current.lock:
        return dialogue.once(current, body.request_id, {"action": "proposal", **body.model_dump()}, lambda: dialogue.proposal(current, body.product_id, body.quantity))


@router.post("/cart/confirm")
def confirm(body: ConfirmInput, current: Annotated[dialogue.Session, Depends(session)]):
    with current.lock:
        return dialogue.once(current, body.request_id, {"action": "confirm", **body.model_dump()}, lambda: dialogue.confirm(current, body.confirmation_id))


@router.post("/cart/cancel")
def cancel(current: Annotated[dialogue.Session, Depends(session)]):
    with current.lock:
        current.pending = None
        if current.state:
            current.state.update({"phase": "idle", "pending": None, "request": None})
        return dialogue.envelope(current, dialogue.reply(current, "Ұсыныс тоқтатылды. Себет өзгерген жоқ."))


@router.delete("/cart/items/{product_id}")
def remove(product_id: int, current: Annotated[dialogue.Session, Depends(session)]):
    with current.lock:
        current.cart.pop(product_id, None)
        current.pending = None
        if current.state:
            current.state.update({"phase": "idle", "pending": None, "request": None})
        return dialogue.cart_view(current)


@router.post("/attachments")
def attachment(file: Annotated[UploadFile, File()], current: Annotated[dialogue.Session, Depends(session)]):
    # Extraction produces a draft only; it never runs dialogue or changes the cart.
    with current.lock:
        current.pending = None
        if current.state:
            current.state.update({"phase": "idle", "pending": None, "request": None})
    content = file.file.read(10 * 1024 * 1024 + 1)
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(413, "Файл өлшемі 10 МБ-тан аспауы керек.")
    return extract_attachment(file.filename or "file", content)
