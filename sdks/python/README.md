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

### Step 2 — Create a Site Key in your StrictProxy Admin Console

1. Open your controller admin page at **`https://YOUR-CONTROLLER/admin#links`**.
2. In **Gatekeeper Key Factory (Site API keys)**, click **Create site key** and give your site a name (e.g. `Partner Portal`).
3. Click **Copy .env** and set those 2 single-line environment variables:

```bash
export STRICT_PROXY_CONTROLLER_URL="https://proxy.example.com"
export STRICT_PROXY_GATEKEEPER_KEY="sp_gk_your_generated_site_secret"
```

> **No multi-line PEMs!** Your single-line `sp_gk_…` site key automatically fetches both your active proxy exit IPs and the controller's Ed25519 signing key in one request — and can be rotated or revoked per site anytime.

### Step 3 — Init, then Auth!

#### FastAPI (3 lines!)

```python
from fastapi import Depends, FastAPI
from strict_proxy_gatekeeper import Gatekeeper

app = FastAPI()

# 1. INIT — tell the bouncer where your StrictProxy controller is
#    (automatically reads STRICT_PROXY_CONTROLLER_URL and STRICT_PROXY_GATEKEEPER_KEY!)
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

## Recipes by Framework & Stack

> **Important rule for React / Vue / Next.js frontends talking to a Python backend:**
> Always run Gatekeeper on your **Python backend** (FastAPI, Flask, Django), never only in browser JS. In your frontend `fetch(...)`, pass `credentials: "include"` so the browser sends the `sp_entitlement` cookie saved by Gatekeeper.

### 1. FastAPI + React / Vite Frontend (Full Stack)

Protect your `/api/*` routes in FastAPI and let your React app call them with cookies enabled:

```python
# main.py (FastAPI)
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from strict_proxy_gatekeeper import Gatekeeper

app = FastAPI()

# Allow your React frontend to send cookies (replace with your real frontend URL)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://app.example.com"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

gk = Gatekeeper.init(
    trust_forwarded_for=True,
    trusted_proxy_hops=1,
)

# Public route — anyone can check status
@app.get("/api/public")
def public_info():
    return {"app": "My Private Portal"}

# Proxy-only route — any connected StrictProxy user
@app.get("/api/private")
def private_area(_=Depends(gk.fastapi_auth())):
    return {"secret": "You are connected through StrictProxy!"}

# Paid-plan route — Standard or Pro users only
@app.get("/api/members")
def members(user=Depends(gk.fastapi_auth("standard"))):
    return {"email": user.email, "plan": user.tier}
```

Then in your React frontend:

```js
// Forward ?sp_ticket=... if the user just clicked a link inside the StrictProxy app
const ticket = new URLSearchParams(window.location.search).get('sp_ticket');
const url = ticket
  ? `https://api.example.com/api/members?sp_ticket=${encodeURIComponent(ticket)}`
  : 'https://api.example.com/api/members';

const res = await fetch(url, { credentials: 'include' });
if (!res.ok) {
  const err = await res.json();
  // Show a friendly "Please connect to StrictProxy" screen using err.hint
}
```

---

### 2. Flask (Mixed Public Landing Page + Private Blueprint)

Keep your homepage public and protect only your `/app` routes:

```python
from flask import Blueprint, Flask, g, render_template_string
from strict_proxy_gatekeeper import Gatekeeper

app = Flask(__name__)
gk = Gatekeeper.init(trust_forwarded_for=True, trusted_proxy_hops=1)

@app.route("/")
def landing():
    return "Public homepage — connect to StrictProxy to visit /app"

# Protect an entire Blueprint at once
private_bp = Blueprint("private", __name__, url_prefix="/app")
private_bp.before_request(gk.flask_before_request("standard"))

@private_bp.route("/")
def dashboard():
    return render_template_string("<h1>Welcome {{ email }}!</h1>", email=g.strict_proxy.email)

app.register_blueprint(private_bp)
```

---

### 3. Django & Django REST Framework (DRF)

Protect individual Django views with `@gk.django_auth(...)`, or protect a DRF `APIView` / `ViewSet` with a reusable permission class:

```python
# permissions.py (Django REST Framework)
from rest_framework.permissions import BasePermission
from strict_proxy_gatekeeper import Gatekeeper

gk = Gatekeeper.init(trust_forwarded_for=True, trusted_proxy_hops=1)

class StrictProxyPermission(BasePermission):
    required_tier = "standard"  # set to None for proxy-only, or "pro"

    def has_permission(self, request, view):
        tier = getattr(view, "strict_proxy_tier", self.required_tier)
        decision = gk.auth(
            ip=request.META.get("REMOTE_ADDR"),
            headers=request.headers,
            query=request.GET,
            secure=request.is_secure(),
            required_tier=tier,
        )
        if not decision.allowed:
            self.message = decision.body
            return False
        request.strict_proxy = decision.user
        return True
```

---

### 4. Starlette / Any ASGI App

```python
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from strict_proxy_gatekeeper import Gatekeeper

gk = Gatekeeper.init(required_tier="standard", trust_forwarded_for=True, trusted_proxy_hops=1)

async def homepage(request):
    user = request.state.strict_proxy
    return JSONResponse({"ok": True, "email": user.email, "plan": user.tier})

app = Starlette(routes=[Route("/", homepage)])
app.add_middleware(gk.asgi_middleware())
```

---

### 5. Any WSGI App (Gunicorn, uWSGI, Pyramid, Bottle)

```python
from strict_proxy_gatekeeper import Gatekeeper

gk = Gatekeeper.init(trust_forwarded_for=True, trusted_proxy_hops=1)
app = gk.wsgi_middleware(my_wsgi_app)
```

---

### 6. Any Other Python Framework (`gk.auth`)

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

---

## What Each Block Message Means

| Status | Code | Plain-English Meaning |
| --- | --- | --- |
| `403` | `GATEKEEPER_DENIED` | Visitor is NOT connected to your StrictProxy VPN (or your controller could not be reached). |
| `401` | `GATEKEEPER_ENTITLEMENT_REQUIRED` | This page needs a paid plan, and no pass/ticket was sent. |
| `401` | `GATEKEEPER_ENTITLEMENT_INVALID` | The pass/ticket expired or was tampered with. Opening the link again from the app gives a fresh one. |
| `403` | `GATEKEEPER_TIER_INSUFFICIENT` | Visitor is on a lower plan (for example, `standard` trying to open a `pro` page). |

---

## Browser Plan-Pass Handoff (Zero-Click SSO for Bookmarks & Direct Visits)

When a VPN-connected visitor hits a plan-gated route directly without `?sp_ticket=`, create a single-use handoff session via `gk.create_pass_handoff()` (RFC 9126 PAR) and redirect `302` to `handoff.handoff_url`:

```python
decision = gk.auth(ip=remote_ip, headers=headers, query=query, secure=is_https)
if not decision.allowed:
    if decision.reason in ("entitlement_missing", "entitlement_invalid") and not decision.had_ticket:
        handoff = gk.create_pass_handoff(return_path=full_path)
        return redirect(handoff.handoff_url, code=302)
    return jsonify(decision.body), decision.status
```

Set **Site URL** on your key in StrictProxy **Admin -> Links -> Gatekeeper Key Factory**. After signing in once at `/pass`, the visitor gets a 7-day `HttpOnly` `sp_pass_session` SSO cookie so future pass refreshes happen with zero clicks.

## Anti-Stampede Caching & Throttling (Built In)

- `min_refresh_interval_seconds` (default `30.0`): cooldown throttling on `gk.refresh()` and `refresh_on_unknown_ip` (use `gk.refresh(force=True)` for explicit operator refresh buttons).
- `stale_while_revalidate_seconds` (default `60.0`): serves cached IPs with zero latency while refreshing in a background thread.
- `failure_backoff_seconds` (default `5.0`): prevents retry storms during a controller outage.
- `refresh_on_unknown_ip` (default `True`): throttled refresh if a newly online node IP is not yet cached.

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
    api_key="sp_gk_...",                         # or env STRICT_PROXY_GATEKEEPER_KEY (recommended)
    cache_ttl_seconds=300.0,                     # how often to refresh proxy IP list
    min_refresh_interval_seconds=30.0,           # cooldown between early refresh() calls
    stale_while_revalidate_seconds=60.0,         # zero-latency background refresh window
    failure_backoff_seconds=5.0,                 # backoff after a failed controller fetch
    refresh_on_unknown_ip=True,                  # throttled refresh when a new node comes online
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
