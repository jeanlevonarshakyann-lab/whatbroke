def total(items, tax):
    return sum(items) + int(tax)


def token_claims(token):
    return {"sub": token.get("sub")}
