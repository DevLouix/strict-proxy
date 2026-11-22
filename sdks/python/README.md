# strict-proxy-gatekeeper

Official Python SDK for **StrictProxy Gatekeeper**.

Lock down any Python web app or API in two steps — **init**, then **auth** — so only users connected through your StrictProxy VPN fleet (and optionally holding a `standard` or `pro` subscription) can access it.

- **Minimal dependency** — depends only on `cryptography` (Ed25519) plus Python's standard library (Python 3.9+).
- **Offline verification** — verifies signed fleet exit-IP lists and signed entitlement tokens locally with zero per-request calls to your controller.
- **Seamless browser tickets** — automatically upgrades `?sp_ticket=` links from the StrictProxy app into an `HttpOnly` cookie so follow-up clicks and assets stay authorized.
- **Built-in adapters** — FastAPI, Starlette, Flask, Django, ASGI, WSGI, and framework-agnostic `gk.auth()`.

---

## Install

```bash
pip install strict-proxy-gatekeeper
```

---

## Quick Start (Init -> Auth)

Copy your **Controller URL** and **Signing Public Key** from your StrictProxy admin console at **`/admin#links`**.

### FastAPI / Starlette

```python
import os
from fastapi import Depends, FastAPI
from strict_proxy_gatekeeper import Gatekeeper

app = FastAPI()

# 1. Init
gk = Gatekeeper.init(
    controller_url=os.environ["STRICT_PROXY_CONTROLLER_URL"],  # e.g. https://proxy.example.com
    public_key=os.environ["STRICT_PROXY_PUBLIC_KEY_PEM"],      # Ed25519 PEM from /admin#links
    trust_forwarded_for=True,
    trusted_proxy_hops=1,  # number of reverse proxies (Caddy/Nginx) in front of your app
)

# 2. Auth — Option A: protect the entire app (proxy-only or set required_tier in init)
app.add_middleware(gk.asgi_middleware())

# 2. Auth — Option B: require a paid plan on specific routes
@app.get("/pro")
def pro_area(user=Depends(gk.fastapi_auth("pro"))):
    return {"email": user.email, "tier": user.tier}
```

### Flask

```python
import os
from flask import Flask, g
from strict_proxy_gatekeeper import Gatekeeper

app = Flask(__name__)

# 1. Init
gk = Gatekeeper.init(
    controller_url=os.environ["STRICT_PROXY_CONTROLLER_URL"],
    public_key=os.environ["STRICT_PROXY_PUBLIC_KEY_PEM"],
    trust_forwarded_for=True,
    trusted_proxy_hops=1,
)

# 2. Auth — protect every route (proxy-only)
app.before_request(gk.flask_before_request())

# Or protect individual routes by plan tier
@app.route("/members")
@gk.flask_auth("standard")
def members():
    return {"email": g.strict_proxy.email, "tier": g.strict_proxy.tier}
```

### Django

```python
from django.http import JsonResponse
from strict_proxy_gatekeeper import Gatekeeper

# Reads STRICT_PROXY_CONTROLLER_URL & STRICT_PROXY_PUBLIC_KEY_PEM from env automatically
gk = Gatekeeper.init(trust_forwarded_for=True, trusted_proxy_hops=1)

@gk.django_auth("pro")
def pro_dashboard(request):
    return JsonResponse({"email": request.strict_proxy.email, "tier": request.strict_proxy.tier})
```

### Framework-agnostic (`gk.auth`)

```python
decision = gk.auth(
    ip=remote_ip,
    headers=request_headers,
    query=query_params,
    secure=True,
    required_tier="standard",  # omit for proxy-only
)
if not decision.allowed:
    return Response(decision.body, status=decision.status)
# decision.user -> EntitlementIdentity(user_id, email, tier, expires_at, current_period_end)
# decision.set_cookie -> optional Set-Cookie value when ?sp_ticket= was upgraded
```

---

## Zero-Config via Environment Variables

Set:

```bash
export STRICT_PROXY_CONTROLLER_URL="https://proxy.example.com"
export STRICT_PROXY_PUBLIC_KEY_PEM="$(cat public-key.pem)"
```

Then initialize with:

```python
gk = Gatekeeper.init(required_tier="standard")
```

> **Tip:** If you omit `public_key` on an `https://` controller, the SDK can auto-fetch the signing key from `/api/v1/network/public-key` on first use. For production deployments, pinning `STRICT_PROXY_PUBLIC_KEY_PEM` is strongly recommended.

---

## Configuration Reference

| Parameter | Default | Description |
| --- | --- | --- |
| `controller_url` | `STRICT_PROXY_CONTROLLER_URL` | Base URL of your StrictProxy controller. |
| `public_key` | `STRICT_PROXY_PUBLIC_KEY_PEM` | Single Ed25519 SPKI public key PEM from `/admin#links`. |
| `public_keys` | `None` | Dict of `key_id -> PEM` for multi-key rotation. |
| `required_tier` | `None` | Minimum plan tier (`"free"`, `"standard"`, `"pro"`). Omit for proxy-only. |
| `trust_forwarded_for` | `False` | Enable when running behind a reverse proxy (Caddy/Nginx/Cloudflare). |
| `trusted_proxy_hops` | `None` | Number of appending reverse proxies in front of your app (`1` for a single proxy). Blocks `X-Forwarded-For` spoofing. |
| `failure_mode` | `"closed"` | `"closed"` denies requests if the allowlist cannot be refreshed; `"open"` allows IPs through. |
| `cache_ttl_seconds` | `300.0` | How long to cache the verified exit-IP allowlist in memory. |
| `fetch_timeout_seconds` | `5.0` | Timeout for controller HTTP requests. |
| `set_cookie_from_query` | `True` | Automatically emit `Set-Cookie` (`HttpOnly; SameSite=Lax`, plus `Secure` over HTTPS) when a valid `?sp_ticket=` arrives. |
| `deny_redirect_url` | `None` | Optional 302 redirect URL instead of JSON denial responses. |

---

## Error Codes

| HTTP Status | `code` | Meaning |
| --- | --- | --- |
| `403` | `GATEKEEPER_DENIED` | Request did not exit an active StrictProxy node (or controller unreachable in `closed` mode). |
| `401` | `GATEKEEPER_ENTITLEMENT_REQUIRED` | Route requires a plan, and no token was provided. |
| `401` | `GATEKEEPER_ENTITLEMENT_INVALID` | Token is malformed, expired, or fails Ed25519 signature verification. |
| `403` | `GATEKEEPER_TIER_INSUFFICIENT` | User's signed plan tier is below `required_tier`. |

---

## Building & Publishing to PyPI

```bash
cd sdks/python
python -m build
twine check dist/*
twine upload dist/*
```

---

## License

MIT
