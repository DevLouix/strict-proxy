# strict-proxy-gatekeeper

**Lock your Python website or API so ONLY your StrictProxy users can open it.**

Think of Gatekeeper like a **bouncer at the front door of your website**:
1. Someone visits your website.
2. Gatekeeper checks: *"Did this person come through your StrictProxy VPN?"*
3. If **YES** -> let them in!
4. If **NO** -> politely block them (`403 Access Denied`).

You can also ask the bouncer to check their **VIP pass** (their `standard` or `pro` plan).

---

## Set It Up in 3 Easy Steps

### Step 1 — Install the package

```bash
pip install strict-proxy-gatekeeper
```

> Needs Python 3.9 or newer. Works with FastAPI, Flask, Django, Starlette, or any Python web app.

### Step 2 — Grab 2 values from your StrictProxy Admin Console

1. Open your controller admin page at **`https://YOUR-CONTROLLER/admin#links`**.
2. Copy:
   - Your **Controller URL** (example: `https://proxy.example.com`)
   - Your **Signing Public Key** (click **Copy public key**)
3. Set them as environment variables (or put them in your `.env`):

```bash
export STRICT_PROXY_CONTROLLER_URL="https://proxy.example.com"
export STRICT_PROXY_PUBLIC_KEY_PEM="-----BEGIN PUBLIC KEY-----
paste-your-public-key-here
-----END PUBLIC KEY-----"
```

### Step 3 — Init, then Auth!

#### FastAPI (3 lines!)

```python
from fastapi import Depends, FastAPI
from strict_proxy_gatekeeper import Gatekeeper

app = FastAPI()

# 1. INIT — tell the bouncer where your StrictProxy controller is
#    (automatically reads STRICT_PROXY_CONTROLLER_URL and STRICT_PROXY_PUBLIC_KEY_PEM!)
gk = Gatekeeper.init()

# 2. AUTH — put the bouncer in front of your whole app
app.add_middleware(gk.asgi_middleware())

@app.get("/")
def home():
    return {"message": "Welcome! You are connected through StrictProxy."}

# Optional: require a Pro plan on one specific route
@app.get("/vip")
def vip(user=Depends(gk.fastapi_auth("pro"))):
    return {"message": f"Welcome Pro VIP {user.email}!"}
```

#### Flask (3 lines!)

```python
from flask import Flask, g
from strict_proxy_gatekeeper import Gatekeeper

app = Flask(__name__)

# 1. INIT
gk = Gatekeeper.init()

# 2. AUTH — protect every route (proxy-only)
app.before_request(gk.flask_before_request())

@app.route("/")
def home():
    return "Welcome! You are connected through StrictProxy."

# Optional: require a Standard or Pro plan on one specific route
@app.route("/members")
@gk.flask_auth("standard")
def members():
    return {"message": f"Hello {g.strict_proxy.email}!", "plan": g.strict_proxy.tier}
```

#### Django (3 lines!)

```python
from django.http import JsonResponse
from strict_proxy_gatekeeper import Gatekeeper

# 1. INIT
gk = Gatekeeper.init()

# 2. AUTH
@gk.django_auth("pro")  # or @gk.django_auth() for proxy-only
def vip_page(request):
    return JsonResponse({
        "message": "Welcome Pro VIP!",
        "email": request.strict_proxy.email,
    })
```

That's it! Anyone NOT connected to your StrictProxy VPN is now blocked automatically.

---

## Pick Who Gets In (Proxy-Only vs Paid Plans)

| What you pass | Who is allowed in? |
| --- | --- |
| *(nothing)* | Anyone connected to your StrictProxy VPN (unless `required_tier` was set in `init`). |
| `"standard"` | Connected to StrictProxy **AND** has a `standard` or `pro` plan. |
| `"pro"` | Connected to StrictProxy **AND** has a `pro` plan. |

> **How do users open a paid-plan website in their browser?**
> Publish the website URL in **`/admin#links`**. When a user taps your link in the StrictProxy app, it opens with a tiny one-time pass (`?sp_ticket=...`). Gatekeeper automatically checks it and saves a safe cookie so every other page click on your site keeps working!

---

## Running Behind Nginx, Caddy, Traefik, or Cloudflare?

If a reverse proxy sits in front of your Python app, your app sees `127.0.0.1` instead of the visitor's real IP. Tell Gatekeeper to read the forwarded IP safely:

```python
gk = Gatekeeper.init(
    trust_forwarded_for=True,
    trusted_proxy_hops=1,  # 1 if you have ONE proxy (e.g. Caddy or Nginx) in front of your app
)
```

> **Why `trusted_proxy_hops=1`?** So nobody can fake their IP address by sending a bogus `X-Forwarded-For` header.

---

## Want to Redirect Blocked Visitors Instead of Showing JSON?

```python
gk = Gatekeeper.init(
    deny_redirect_url="https://yoursite.com/get-strict-proxy",
)
```

---

## Using Any Other Python Framework (`gk.auth`)

You can call `gk.auth(...)` directly anywhere:

```python
result = gk.auth(
    ip=visitor_ip,
    headers=request_headers,
    query=query_params,
    secure=True,               # True if the request used HTTPS
    required_tier="standard",  # omit for proxy-only
)

if not result.allowed:
    # result.status -> 403 or 401 (or 302 if redirect)
    # result.body   -> friendly JSON error dict
    return Response(result.body, status=result.status)

# Allowed!
# result.user       -> EntitlementIdentity(user_id, email, tier, ...) or None
# result.set_cookie -> Set-Cookie header string (if a ?sp_ticket= was upgraded)
```

You can also wrap any WSGI app with `app = gk.wsgi_middleware(app)`.

---

## What Each Block Message Means

| Status | Code | Plain-English Meaning |
| --- | --- | --- |
| `403` | `GATEKEEPER_DENIED` | Visitor is NOT connected to your StrictProxy VPN (or your controller could not be reached). |
| `401` | `GATEKEEPER_ENTITLEMENT_REQUIRED` | This page needs a paid plan, and no pass/ticket was sent. |
| `401` | `GATEKEEPER_ENTITLEMENT_INVALID` | The pass/ticket expired or was tampered with. Opening the link again from the app gives a fresh one. |
| `403` | `GATEKEEPER_TIER_INSUFFICIENT` | Visitor is on a lower plan (for example, `standard` trying to open a `pro` page). |

---

## Troubleshooting (Common Questions)

- **I am connected to StrictProxy, why am I still blocked?**
  1. Check `/admin#links` -> **Active exit IPs**. Make sure at least one proxy node is **Online**.
  2. If your app is behind Nginx, Caddy, or Cloudflare, make sure you enabled `trust_forwarded_for=True` and `trusted_proxy_hops=1`.
- **Do I have to pass `public_key`?**
  - Setting `STRICT_PROXY_PUBLIC_KEY_PEM` is best for production (fast and extra secure). If your controller uses `https://` and you leave `public_key` out, Gatekeeper will fetch it once automatically.
- **Does Gatekeeper slow down my app?**
  - No! It caches your proxy IP list for 5 minutes and checks user passes completely offline (no network call per visitor).

---

## All Options (Reference)

```python
gk = Gatekeeper.init(
    controller_url="https://proxy.example.com",  # or env STRICT_PROXY_CONTROLLER_URL
    public_key="-----BEGIN PUBLIC KEY-----...",  # or env STRICT_PROXY_PUBLIC_KEY_PEM
    public_keys={"primary": "..."},              # optional: use when rotating multiple keys
    required_tier="standard",                    # optional: "free" | "standard" | "pro"
    trust_forwarded_for=False,                   # set True behind Nginx/Caddy/Cloudflare
    trusted_proxy_hops=1,                        # number of proxies in front of your app
    failure_mode="closed",                       # "closed" (safe default) or "open"
    cache_ttl_seconds=300.0,                     # how often to refresh proxy IP list
    set_cookie_from_query=True,                  # auto-save ?sp_ticket= into an HttpOnly cookie
    deny_redirect_url=None,                      # optional 302 redirect URL for blocked visitors
)
```

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
