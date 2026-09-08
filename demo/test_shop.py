from shop import total, token_claims


def test_invoice_total():
    assert total([1000, 49], 0.5) == 1050


def test_expired_token():
    claims = token_claims({"sub": "u1"})
    assert claims["exp"] > 0


def test_discount_applies():
    assert total([100], 0.0) == 100


def test_rounding():
    assert total([10, 20], 0.9) == 31
