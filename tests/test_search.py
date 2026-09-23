"""Catalog adapter/search contracts, with no live EKT requests."""

from unittest.mock import patch

import pytest

from backend.shop import Catalog, matches_tokens, normalize, tokens


def raw(product_id=7, name="Legrand автомат 160А", article="0007_"):
    return {
        "id": product_id, "name": name, "article": article,
        "price": 100, "quantity": 10,
        "properties": {"NOMINALNOE_NAPRYAZHENIE": "400В", "NOMINALNYY_TOK": "160 А"},
        "stores": [{"id": 13, "name": "Алматы", "quantity": 4}],
    }


@pytest.mark.parametrize("query", [
    "Legrand бағасы қандай", "Legrand сертификаты бар ма?",
    "Legrand сипаттамасы қандай", "цена на Legrand", "сколько стоит Legrand?",
    "Legrand есть в наличии", "Legrand напряжение",
])
def test_info_words_do_not_become_catalog_search_terms(query):
    catalog = Catalog()
    value = normalize(raw())
    with patch.object(catalog, "sample", return_value=([value], {"complete": False})), patch.object(catalog, "detail", return_value=value):
        found = catalog.search(query)
    assert [product["id"] for product in found["items"]] == [7]


@pytest.mark.parametrize("query", ["60А", "60 A", "автомат 60а"])
def test_numeric_current_is_not_matched_inside_a_different_rating(query):
    assert not matches_tokens(tokens(query), tokens("автомат 160А"))
    assert matches_tokens(tokens(query), tokens("автомат 60 А"))


def test_numeric_article_is_exact_and_is_not_a_product_id():
    catalog = Catalog()
    products = [normalize(raw()), normalize(raw(8, "Legrand", "7"))]
    with patch.object(catalog, "sample", return_value=(products, {"complete": False})), patch.object(catalog, "detail", side_effect=lambda product_id: next(p for p in products if p["id"] == product_id)):
        assert [p["id"] for p in catalog.search("артикул 7 бағасы")["items"]] == [8]
        assert [p["id"] for p in catalog.search("sku 0007_")["items"]] == [7]


def test_purchased_quantity_is_removed_without_losing_electrical_rating():
    catalog = Catalog()
    product = normalize(raw())
    with patch.object(catalog, "sample", return_value=([product], {"complete": False})), patch.object(catalog, "detail", return_value=product):
        assert catalog.search("Legrand 160А 3 дана керек")["items"] == [product]


def test_voltage_alias_preserves_source_value_and_warehouse_identity():
    source = raw()
    product = normalize(source)
    assert product["attributes"]["voltage"] == "400В"
    assert product["attributes"]["NOMINALNOE_NAPRYAZHENIE"] == "400В"
    assert "voltage" not in source["properties"]
    assert product["warehouse_stocks"][0] == {"warehouse_id": "13", "id": 13, "name": "Алматы", "quantity": 4}
    assert product["attributes"].get("power") is None


def test_only_explicit_power_data_is_used():
    source = raw()
    source["power"] = "5 W"
    assert normalize(source)["attributes"]["power"] == "5 W"
    del source["power"]
    source["description"] = "Power may be 5 W."
    assert normalize(source)["attributes"].get("power") is None


def test_technical_conflicts_remain_visible_after_attribute_adaptation():
    source = raw()
    source["properties"]["NOMINALNYY_TOK"] = "250 А"
    product = normalize(source)
    assert product["warnings"]
    assert product["attributes"]["NOMINALNYY_TOK"] == "250 А"
    assert "160А" in product["name"]
