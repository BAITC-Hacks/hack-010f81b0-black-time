"""Local FastAPI backend for ekt.kz catalog access."""

from pathlib import Path as FilePath
from typing import Annotated, Any

from fastapi import FastAPI, Path, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from backend import ekt_client
from backend.integration import router


app = FastAPI(title="ekt.kz каталог backend", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5500",
        "http://127.0.0.1:5500",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
    allow_credentials=True,
)
app.include_router(router)
ROOT = FilePath(__file__).resolve().parent.parent
app.mount("/frontend", StaticFiles(directory=ROOT / "frontend", check_dir=False), name="frontend")


@app.middleware("http")
async def private_responses(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/", include_in_schema=False)
@app.get("/cart", include_in_schema=False)
def frontend():
    return FileResponse(ROOT / "index.html")


@app.exception_handler(ekt_client.EktAPIError)
async def handle_ekt_error(request: Request, exc: ekt_client.EktAPIError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/products")
def products(page: Annotated[int, Query(gt=0)] = 1) -> dict[str, Any]:
    return {"source": "ekt.kz", "data": ekt_client.get_products(page)}


@app.get("/products/{product_id}")
def product(product_id: Annotated[int, Path(gt=0)]) -> dict[str, Any]:
    return {"source": "ekt.kz", "data": ekt_client.get_product(product_id)}
