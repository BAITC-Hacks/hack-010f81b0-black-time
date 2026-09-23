"""Bounded, cached catalog search and an explicit adapter for observed EKT fields."""

import math
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.parse import urlsplit

from backend import ekt_client


def number(value: Any) -> int | float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        result = float(str(value).replace(",", "."))
        if not math.isfinite(result) or result < 0:
            return None
        return int(result) if result.is_integer() else result
    except (TypeError, ValueError, OverflowError):
        return None


def safe_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        url = urlsplit(value)
        if url.scheme in ("https", "http") and url.hostname and not url.username and not url.password:
            return value
    except ValueError:
        pass
    return None


def normalize(raw: dict) -> dict:
    product_id = number(raw.get("id"))
    if not isinstance(product_id, int) or product_id <= 0 or not isinstance(raw.get("name"), str):
        raise ekt_client.EktAPIError(502, "Каталогтағы тауар пішімі жарамсыз.")
    props = raw.get("properties") if isinstance(raw.get("properties"), dict) else {}
    attributes = dict(props)
    # Preserve raw facts and provide the dialogue's common accessors. Voltage is
    # mapped from an observed EKT property; unknown power fields stay unknown.
    if props.get("NOMINALNOE_NAPRYAZHENIE") is not None:
        attributes["voltage"] = props["NOMINALNOE_NAPRYAZHENIE"]
    elif raw.get("voltage") is not None:
        attributes["voltage"] = raw["voltage"]
    if raw.get("power") is not None:
        attributes["power"] = raw["power"]
    stock, price = number(raw.get("quantity")), number(raw.get("price"))
    currency = raw.get("currency") or os.getenv("CATALOG_CURRENCY") or None
    warnings = []
    title_current = re.search(r"(\d+(?:[.,]\d+)?)\s*[аa]\b", raw["name"], re.I)
    property_current = re.search(r"\d+(?:[.,]\d+)?", str(props.get("NOMINALNYY_TOK", "")))
    if title_current and property_current and number(title_current[1]) != number(property_current[0]):
        warnings.append("Атаудағы ток пен NOMINALNYY_TOK мәндері сәйкес емес. Менеджерден нақтылаңыз.")
    stores = []
    for store in raw.get("stores", []) if isinstance(raw.get("stores"), list) else []:
        if isinstance(store, dict):
            stores.append({"warehouse_id": str(store["id"]) if store.get("id") is not None else None, "id": store.get("id"), "name": store.get("name"), "quantity": number(store.get("quantity"))})
    certificate = safe_url(raw.get("certificate_url"))
    return {
        "id": product_id, "name": raw["name"], "sku": raw.get("article"),
        "category": raw.get("category") or props.get("OBYEM"),
        "description": raw.get("description"), "attributes": attributes,
        "price": price, "currency": currency, "stock": stock,
        "availability": "unknown" if stock is None else "available" if stock > 0 else "unavailable",
        "warehouse_stocks": stores, "certificate_url": certificate,
        "image": safe_url(raw.get("image")), "url": safe_url(raw.get("url")),
        "warnings": warnings, "minimum_order": number(props.get("KRATNOST_MIN")),
        "order_multiple": number(raw.get("order_multiple")),
    }


def tokens(text: str) -> list[str]:
    text = text.casefold()
    text = re.sub(r"(\d)\s*[аa]\b", r"\1a", text)
    text = re.sub(r"(\d)\s*[вv]\b", r"\1v", text)
    text = re.sub(r"(\d)\s*ка\b", r"\1ka", text)
    stop = {"маған", "мне", "нужен", "нужна", "нужно", "керек", "ізде", "іздеу", "тауып", "бер", "найди", "найти", "ищу", "бар", "ма", "ме", "ба", "бе", "артикул", "sku", "қандай", "қанша", "тауар", "товар", "пожалуйста", "дана", "шт", "қос", "себетке", "добавь", "корзину", "в", "есть", "ли", "осы", "оның", "одан", "этот", "этого", "его", "на", "по", "бойынша", "қолда", "какой", "какая", "какие", "сколько", "стоит", "тұрады"}
    intent_word = re.compile(r"^(?:сертификат[\w]*|сипаттама[\w]*|характеристик[\w]*|описани[\w]*|баға[\w]*|цена|цены|цену|қалдық[\w]*|остат[\w]*|қойма[\w]*|склад[\w]*|кернеу[\w]*|напряжени[\w]*|қуат[\w]*|мощност[\w]*|наличи[\w]*)$")
    return [token for token in re.findall(r"[\w.-]+", text) if token not in stop and not intent_word.fullmatch(token)]


def matches_tokens(wanted: list[str], haystack: list[str]) -> bool:
    # Numeric electrical specs must not match a substring: 60 A is not 160 A.
    return bool(wanted) and all(
        word in haystack if any(char.isdigit() for char in word)
        else any(word in candidate for candidate in haystack)
        for word in wanted
    )


class Catalog:
    def __init__(self) -> None:
        self._pages: dict[int, tuple[float, dict]] = {}
        self._lock = threading.Lock()

    def clear_cache(self) -> None:
        with self._lock:
            self._pages.clear()

    @property
    def max_pages(self) -> int:
        try:
            return max(1, min(20, int(os.getenv("CATALOG_MAX_PAGES", "3"))))
        except ValueError:
            return 3

    def page(self, page: int) -> dict:
        with self._lock:
            cached = self._pages.get(page)
        if cached and time.monotonic() - cached[0] < 120:
            return cached[1]
        result = ekt_client.get_products(page)
        if not isinstance(result, dict) or not isinstance(result.get("items"), list):
            raise ekt_client.EktAPIError(502, "Каталог бетінің JSON құрылымы күтілген пішімге сәйкес емес.")
        with self._lock:
            self._pages[page] = (time.monotonic(), result)
        return result

    def detail(self, product_id: int) -> dict:
        raw = ekt_client.get_product(product_id)
        if not isinstance(raw, dict) or raw.get("id") != product_id:
            raise ekt_client.EktAPIError(502, "Сыртқы API сұралған тауардың мәліметін қайтармады.")
        return normalize(raw)

    def sample(self) -> tuple[list[dict], dict]:
        # Representative bounded sample, never an automatic full-catalog crawl.
        with ThreadPoolExecutor(max_workers=min(3, self.max_pages)) as pool:
            pages = list(pool.map(self.page, range(1, self.max_pages + 1)))
        products: dict[int, dict] = {}
        complete = False
        for page in pages:
            for raw in page["items"]:
                product = normalize(raw)
                products[product["id"]] = product
            if not page["items"]:
                complete = True
                break
        return list(products.values()), {"pages_loaded": len(pages), "max_pages": self.max_pages, "complete": complete}

    def search(self, query: str) -> dict:
        explicit_id = re.fullmatch(r"\s*id\s*[:#]?\s*(\d+)\s*", query, re.I)
        if explicit_id:
            return {"items": [self.detail(int(explicit_id[1]))], "coverage": {"pages_loaded": 0, "max_pages": self.max_pages, "complete": False}}
        products, coverage = self.sample()
        wanted = tokens(re.sub(r"\b\d+\s*(?:дана|шт(?:ук[аи]?)?)\b", "", query, flags=re.I))
        sku = re.search(r"(?:артикул|sku)\s*[:#]?\s*([\w.-]+)", query, re.I)
        matches = []
        for product in products:
            haystack = tokens(f"{product['name']} {product.get('sku') or ''}")
            if sku:
                match = str(product.get("sku") or "").casefold() == sku[1].casefold()
            else:
                match = matches_tokens(wanted, haystack)
            if match:
                matches.append(product)
        # Stock is not present in list responses: hydrate only displayed matches.
        with ThreadPoolExecutor(max_workers=3) as pool:
            detailed = list(pool.map(self.detail, [p["id"] for p in matches[:5]]))
        return {"items": detailed, "coverage": coverage}

    def alternatives(self, product_id: int | None, query: str = "") -> list[dict]:
        if product_id is None:
            return []  # Without source specs there is no evidence for equivalence.
        source = self.detail(product_id)
        if source["warnings"]:
            return []
        sample, _ = self.sample()
        # Bound detail calls too. Prefer the same manufacturer/family words.
        source_words = set(tokens(source["name"]))
        sample.sort(key=lambda p: len(source_words & set(tokens(p["name"]))), reverse=True)
        candidates = [p for p in sample if p["id"] != product_id][:8]
        essential = ("KOLICHESTVO_POLYUSOV", "NOMINALNYY_TOK", "NOMINALNOE_NAPRYAZHENIE", "NOMINALNAYA_OTKLYUCHAYUSHCHAYA_SPOSOBNOST", "TIP_USTANOVKI")
        result = []
        with ThreadPoolExecutor(max_workers=3) as pool:
            for candidate in pool.map(self.detail, [p["id"] for p in candidates]):
                if candidate["stock"] is None or candidate["stock"] <= 0 or candidate["warnings"]:
                    continue
                if not source["category"] or source["category"] != candidate["category"]:
                    continue
                compared = [(source["attributes"].get(k), candidate["attributes"].get(k)) for k in essential if source["attributes"].get(k) is not None]
                if compared and all(str(a).casefold().replace(" ", "") == str(b).casefold().replace(" ", "") for a, b in compared):
                    result.append(candidate)
        return result[:3]


SHOP = Catalog()
