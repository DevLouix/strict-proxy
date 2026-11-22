"""Core StrictProxy Gatekeeper SDK for Python."""

from __future__ import annotations

import base64
import inspect
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import wraps
from typing import Any, Callable, Mapping, Optional, Sequence, Union

from .crypto import (
    b64url_decode,
    load_signing_public_key,
    normalize_pem,
    validate_public_key_pem,
    verify_json,
)

SubscriptionTier = str  # "free" | "standard" | "pro"

TIER_RANK: dict[str, int] = {
    "free": 0,
    "standard": 1,
    "pro": 2,
}

_VALID_TIERS = frozenset(TIER_RANK.keys())
_VALID_STATUSES = frozenset({"active", "inactive", "expired", "cancelled"})
_COOKIE_NAME_RE = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
_UNSET: Any = object()
_DEFAULT_LOGGER = logging.getLogger("strict_proxy_gatekeeper")


def tier_satisfies(actual: str, required: str) -> bool:
    """Returns True when `actual` satisfies a gate requiring at least `required`."""
    if actual not in TIER_RANK or required not in TIER_RANK:
        return False
    return TIER_RANK[actual] >= TIER_RANK[required]


@dataclass(frozen=True)
class EntitlementIdentity:
    """Verified user identity extracted from a signed StrictProxy entitlement token."""

    user_id: str
    email: str
    tier: str
    expires_at: str
    current_period_end: Optional[str]


@dataclass(frozen=True)
class EntitlementVerification:
    """Result of verifying an `sp1.*` entitlement token offline."""

    ok: bool
    entitlement: Optional[EntitlementIdentity] = None
    reason: Optional[str] = None


@dataclass(frozen=True)
class PassHandoffResult:
    """Result returned by `Gatekeeper.create_pass_handoff()` (RFC 9126 PAR)."""

    session_id: str
    handoff_url: str
    expires_in: int


@dataclass(frozen=True)
class AuthDecision:
    """Authorization decision returned by `Gatekeeper.auth()`."""

    allowed: bool
    ip: Optional[str] = None
    user: Optional[EntitlementIdentity] = None
    set_cookie: Optional[str] = None
    reason: Optional[str] = None
    status: int = 200
    code: Optional[str] = None
    body: Optional[dict[str, Any]] = None
    redirect_url: Optional[str] = None
    fetch_error: Optional[str] = None
    had_ticket: bool = False


def safe_return_path(raw: Any, query_param: str = "sp_ticket") -> str:
    """Sanitizes a relative return path for same-site pass handoff redirects.

    Rejects protocol-relative (`//evil.com`), absolute URLs, backslashes, and CR/LF,
    and strips any stale `sp_ticket` query parameter so redirects never loop.
    """
    if not isinstance(raw, str):
        return "/"
    s = raw.strip()
    if not s or len(s) > 1024:
        return "/"
    if not s.startswith("/") or s.startswith("//") or "\\" in s or any(ch in s for ch in ("\r", "\n", "\x00")):
        return "/"
    try:
        parsed = urllib.parse.urlsplit(s)
        if parsed.scheme or parsed.netloc:
            return "/"
        if not parsed.path.startswith("/") or parsed.path.startswith("//"):
            return "/"
        pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        filtered = [(k, v) for k, v in pairs if k != query_param]
        qs = urllib.parse.urlencode(filtered)
        return f"{parsed.path}?{qs}" if qs else parsed.path
    except Exception:
        return "/"


def _normalize_ip(raw: str) -> str:
    s = raw.strip()
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        s = s[1:-1].strip()
    if s.startswith("["):
        end = s.find("]")
        if end > 1:
            s = s[1:end]
    elif s.count(":") == 1:
        host, port = s.split(":", 1)
        if host and port.isdigit():
            s = host
    if s.lower().startswith("::ffff:"):
        s = s[7:]
    return s.lower() if ":" in s else s


def _read_header(headers: Optional[Mapping[str, Any]], name: str) -> Optional[str]:
    if not headers:
        return None
    target = name.lower()
    for k, v in headers.items():
        if str(k).lower() != target:
            continue
        if v is None:
            return None
        if isinstance(v, (list, tuple)):
            return ", ".join(str(x) for x in v)
        return str(v)
    return None


def _read_query_param(query: Optional[Mapping[str, Any]], param: str) -> Optional[str]:
    if not query:
        return None
    val = query.get(param)
    if isinstance(val, str) and val:
        return val
    if isinstance(val, (list, tuple)) and val and isinstance(val[0], str) and val[0]:
        return val[0]
    return None


def client_ip_of(
    remote_address: Optional[str],
    headers: Optional[Mapping[str, Any]] = None,
    *,
    trust_forwarded_for: bool = False,
    trusted_proxy_hops: Optional[int] = None,
) -> Optional[str]:
    """Extracts the client IP, honoring `X-Forwarded-For` when configured."""
    if trust_forwarded_for:
        xff = _read_header(headers, "x-forwarded-for")
        if xff:
            entries = [part.strip() for part in xff.split(",")]
            if trusted_proxy_hops is not None and trusted_proxy_hops >= 1:
                non_empty = [part for part in entries if part]
                if non_empty:
                    idx = max(0, len(non_empty) - int(trusted_proxy_hops))
                    return _normalize_ip(non_empty[idx])
            else:
                if entries and entries[0]:
                    return _normalize_ip(entries[0])
    if not remote_address:
        return None
    return _normalize_ip(remote_address)


def entitlement_token_with_source_of(
    headers: Optional[Mapping[str, Any]] = None,
    query: Optional[Mapping[str, Any]] = None,
    *,
    header_name: str = "x-strict-proxy-entitlement",
    query_param: str = "sp_ticket",
    cookie_name: str = "sp_entitlement",
) -> Optional[tuple[str, str]]:
    """Extracts `(token, source)` with priority: header -> query -> cookie."""
    from_header = _read_header(headers, header_name)
    if from_header:
        return (from_header, "header")

    from_query = _read_query_param(query, query_param)
    if from_query:
        return (from_query, "query")

    cookie_hdr = _read_header(headers, "cookie")
    if not cookie_hdr:
        return None
    for part in cookie_hdr.split(";"):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        if k.strip() != cookie_name:
            continue
        raw = v.strip()
        if not raw:
            continue
        return (urllib.parse.unquote(raw), "cookie")
    return None


def entitlement_token_of(
    headers: Optional[Mapping[str, Any]] = None,
    query: Optional[Mapping[str, Any]] = None,
    *,
    header_name: str = "x-strict-proxy-entitlement",
    query_param: str = "sp_ticket",
    cookie_name: str = "sp_entitlement",
) -> Optional[str]:
    """Extracts the entitlement token string (header -> query -> cookie)."""
    found = entitlement_token_with_source_of(
        headers,
        query,
        header_name=header_name,
        query_param=query_param,
        cookie_name=cookie_name,
    )
    return found[0] if found else None


def _parse_iso_timestamp(raw: str) -> Optional[float]:
    try:
        normalized = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except (ValueError, TypeError):
        return None


def _is_valid_claims(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    return (
        value.get("version") == 1
        and isinstance(value.get("keyId"), str)
        and isinstance(value.get("sub"), str)
        and isinstance(value.get("email"), str)
        and isinstance(value.get("tier"), str)
        and value.get("tier") in _VALID_TIERS
        and isinstance(value.get("status"), str)
        and value.get("status") in _VALID_STATUSES
        and (value.get("currentPeriodEnd") is None or isinstance(value.get("currentPeriodEnd"), str))
        and isinstance(value.get("issuedAt"), str)
        and isinstance(value.get("expiresAt"), str)
    )


def verify_entitlement_token(
    token: Optional[str],
    public_keys: Union[Mapping[str, str], str],
    *,
    now_seconds: Optional[float] = None,
    leeway_seconds: float = 30.0,
) -> EntitlementVerification:
    """Verifies an `sp1.*` entitlement token offline using Ed25519 public key(s)."""
    if not token:
        return EntitlementVerification(ok=False, reason="malformed")
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != "sp1":
        return EntitlementVerification(ok=False, reason="malformed")

    try:
        claims = json.loads(b64url_decode(parts[1]).decode("utf-8"))
    except Exception:
        return EntitlementVerification(ok=False, reason="malformed")

    if not _is_valid_claims(claims):
        return EntitlementVerification(ok=False, reason="malformed")

    key_id: str = claims["keyId"]
    key_pem = public_keys if isinstance(public_keys, str) else public_keys.get(key_id)
    if not key_pem:
        return EntitlementVerification(ok=False, reason="unknown_key")

    try:
        sig_b64 = base64.b64encode(b64url_decode(parts[2])).decode("ascii")
        pub_key = load_signing_public_key(key_id, key_pem)
    except Exception:
        return EntitlementVerification(ok=False, reason="bad_signature")

    if not verify_json(pub_key, claims, sig_b64):
        return EntitlementVerification(ok=False, reason="bad_signature")

    now = time.time() if now_seconds is None else now_seconds
    expires_at = _parse_iso_timestamp(claims["expiresAt"])
    issued_at = _parse_iso_timestamp(claims["issuedAt"])
    if expires_at is None or expires_at + leeway_seconds < now:
        return EntitlementVerification(ok=False, reason="expired")
    if issued_at is None or issued_at - leeway_seconds > now:
        return EntitlementVerification(ok=False, reason="inactive")

    return EntitlementVerification(
        ok=True,
        entitlement=EntitlementIdentity(
            user_id=claims["sub"],
            email=claims["email"],
            tier=claims["tier"],
            expires_at=claims["expiresAt"],
            current_period_end=claims["currentPeriodEnd"],
        ),
    )


def _build_entitlement_cookie(
    cookie_name: str,
    token: str,
    expires_at_iso: str,
    is_https: bool,
) -> Optional[str]:
    if not _COOKIE_NAME_RE.match(cookie_name):
        return None
    exp_ts = _parse_iso_timestamp(expires_at_iso)
    remaining = max(1, int((exp_ts - time.time()) if exp_ts is not None else 60))
    parts = [
        f"{cookie_name}={urllib.parse.quote(token, safe='')}",
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        f"Max-Age={remaining}",
    ]
    if is_https:
        parts.append("Secure")
    return "; ".join(parts)


def _is_loopback_host(hostname: Optional[str]) -> bool:
    if not hostname:
        return False
    h = hostname.strip("[]").lower()
    return h in {"localhost", "127.0.0.1", "::1"} or h.startswith("127.")


def _is_private_or_internal_host(hostname: Optional[str]) -> bool:
    if not hostname:
        return False
    h = hostname.strip("[]").lower()
    if _is_loopback_host(h):
        return True
    if "." not in h and ":" not in h:
        return True
    if h.endswith(".local") or h.endswith(".internal"):
        return True
    if re.match(r"^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$", h):
        return True
    if re.match(r"^192\.168\.\d{1,3}\.\d{1,3}$", h):
        return True
    m172 = re.match(r"^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$", h)
    if m172 and 16 <= int(m172.group(1)) <= 31:
        return True
    return False


def _default_http_get_json(
    url: str,
    timeout_seconds: float,
    headers: Optional[Mapping[str, str]] = None,
) -> dict[str, Any]:
    req_headers = {
        "Accept": "application/json",
        "User-Agent": "strict-proxy-gatekeeper-py/0.3.0",
    }
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(url, headers=req_headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            status = getattr(resp, "status", 200)
            if status < 200 or status >= 300:
                raise RuntimeError(f"HTTP {status} from {url}")
            raw = resp.read().decode("utf-8")
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403) and "/gatekeeper/bootstrap" in url:
            raise RuntimeError(
                f"gatekeeper bootstrap rejected ({exc.code}): invalid, revoked, or expired api_key"
            ) from exc
        if exc.code == 404 and "/gatekeeper/bootstrap" in url:
            raise RuntimeError(
                f"gatekeeper bootstrap failed (404): controller does not expose /api/v1/gatekeeper/bootstrap yet ({url})"
            ) from exc
        raise RuntimeError(f"HTTP {exc.code} from {url}: {exc.reason}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"fetch failed for {url} ({exc.reason})") from exc


def _default_http_post_json(
    url: str,
    payload: Mapping[str, Any],
    timeout_seconds: float,
    headers: Optional[Mapping[str, str]] = None,
) -> dict[str, Any]:
    req_headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "strict-proxy-gatekeeper-py/0.3.0",
    }
    if headers:
        req_headers.update(headers)
    data = json.dumps(dict(payload)).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=req_headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            status = getattr(resp, "status", 200)
            if status < 200 or status >= 300:
                raise RuntimeError(f"HTTP {status} from {url}")
            raw = resp.read().decode("utf-8")
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        detail = f"HTTP {exc.code}"
        try:
            err_body = json.loads(exc.read().decode("utf-8"))
            if isinstance(err_body, dict) and err_body.get("error"):
                detail = f"{detail}: {err_body['error']}"
        except Exception:
            pass
        raise RuntimeError(f"gatekeeper request failed ({detail}) for {url}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"fetch failed for {url} ({exc.reason})") from exc


class Gatekeeper:
    """StrictProxy Gatekeeper SDK for Python.

    Two-step usage:
        gk = Gatekeeper.init(
            controller_url="https://proxy.example.com",
            public_key=os.environ["STRICT_PROXY_PUBLIC_KEY_PEM"],
            required_tier="standard",
        )
        decision = gk.auth(ip=remote_ip, headers=headers, query=query)
    """

    def __init__(
        self,
        *,
        controller_url: Optional[str] = None,
        api_key: Optional[str] = None,
        public_key: Optional[str] = None,
        key_id: Optional[str] = None,
        public_keys: Optional[Mapping[str, str]] = None,
        auto_fetch_public_key: bool = True,
        allow_insecure_http: bool = False,
        required_tier: Optional[str] = None,
        cache_ttl_seconds: float = 300.0,
        min_refresh_interval_seconds: Optional[float] = None,
        failure_backoff_seconds: Optional[float] = None,
        stale_while_revalidate_seconds: Optional[float] = None,
        refresh_on_unknown_ip: bool = True,
        fetch_timeout_seconds: float = 5.0,
        entitlement_header: str = "x-strict-proxy-entitlement",
        entitlement_query_param: str = "sp_ticket",
        entitlement_cookie: str = "sp_entitlement",
        set_cookie_from_query: bool = True,
        entitlement_leeway_seconds: float = 30.0,
        deny_status: Optional[int] = None,
        deny_body: Optional[dict[str, Any]] = None,
        deny_redirect_url: Optional[str] = None,
        trust_forwarded_for: bool = False,
        trusted_proxy_hops: Optional[int] = None,
        failure_mode: str = "closed",
        http_get_json: Optional[Callable[..., dict[str, Any]]] = None,
        http_post_json: Optional[Callable[..., dict[str, Any]]] = None,
        logger: Optional[Callable[[str], None]] = None,
    ) -> None:
        raw_url = (
            controller_url
            or os.environ.get("STRICT_PROXY_CONTROLLER_URL", "")
            or os.environ.get("STRICT_PROXY_URL", "")
        ).strip()
        if not raw_url:
            raise ValueError(
                "Gatekeeper.init() requires `controller_url` (or env STRICT_PROXY_CONTROLLER_URL)."
            )
        parsed = urllib.parse.urlparse(raw_url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError(f"Gatekeeper: controller_url must use http:// or https:// (got {raw_url!r})")

        self._parsed_url = parsed
        clean_url = urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))
        self._controller_base_url = clean_url.rstrip("/")

        raw_api_key = (
            api_key
            or os.environ.get("STRICT_PROXY_GATEKEEPER_KEY", "")
            or os.environ.get("STRICT_PROXY_API_KEY", "")
        ).strip()
        self._api_key: Optional[str] = raw_api_key or None

        env_key = os.environ.get("STRICT_PROXY_PUBLIC_KEY_PEM", "").strip()
        env_key_id = (
            os.environ.get("STRICT_PROXY_SIGNING_KEY_ID", "")
            or os.environ.get("STRICT_PROXY_KEY_ID", "")
        ).strip()
        self._pinned_keys: dict[str, str] = (
            {k: validate_public_key_pem(v) for k, v in public_keys.items()} if public_keys else {}
        )
        single_key = (
            (public_key or "").strip()
            or (env_key if not self._api_key and not public_keys and env_key else "")
        )
        self._pinned_single_key: Optional[str] = validate_public_key_pem(single_key) if single_key else None
        if self._pinned_single_key and (key_id or env_key_id):
            self._pinned_keys[key_id or env_key_id] = self._pinned_single_key

        self._discovered_keys: Optional[dict[str, str]] = None
        self._auto_fetch_public_key = auto_fetch_public_key
        self._allow_insecure_http = allow_insecure_http

        if (
            not self._api_key
            and not self._pinned_single_key
            and not self._pinned_keys
            and not self._auto_fetch_public_key
        ):
            raise ValueError(
                "Gatekeeper.init() requires `api_key`, `public_key`, or `public_keys` when `auto_fetch_public_key` is False."
            )

        if required_tier is not None and required_tier not in _VALID_TIERS:
            raise ValueError(f"Gatekeeper: unknown required_tier {required_tier!r}")
        if failure_mode not in {"closed", "open"}:
            raise ValueError("Gatekeeper: failure_mode must be 'closed' or 'open'")

        self._default_required_tier = required_tier
        self._cache_ttl_seconds = max(0.0, float(cache_ttl_seconds))
        self._min_refresh_interval_seconds = (
            max(0.0, float(min_refresh_interval_seconds))
            if min_refresh_interval_seconds is not None
            else min(30.0, self._cache_ttl_seconds)
        )
        self._failure_backoff_seconds = (
            max(0.0, float(failure_backoff_seconds))
            if failure_backoff_seconds is not None
            else min(5.0, self._cache_ttl_seconds)
        )
        self._swr_seconds = (
            max(0.0, float(stale_while_revalidate_seconds))
            if stale_while_revalidate_seconds is not None
            else min(60.0, self._cache_ttl_seconds / 2.0)
        )
        self._refresh_on_unknown_ip = bool(refresh_on_unknown_ip)
        self._fetch_timeout_seconds = float(fetch_timeout_seconds)
        self._entitlement_header = entitlement_header.lower()
        self._entitlement_query_param = entitlement_query_param
        self._entitlement_cookie = entitlement_cookie
        self._set_cookie_from_query = set_cookie_from_query
        self._entitlement_leeway_seconds = float(entitlement_leeway_seconds)
        self._deny_status = deny_status
        self._deny_body = deny_body
        self._deny_redirect_url = deny_redirect_url
        self._trust_forwarded_for = trust_forwarded_for
        self._trusted_proxy_hops = trusted_proxy_hops
        self._failure_closed = failure_mode == "closed"
        self._http_get_json = http_get_json or _default_http_get_json
        self._http_post_json = http_post_json or _default_http_post_json
        self._logger = logger

        self._lock = threading.Lock()
        self._fetch_lock = threading.Lock()
        self._refreshing = False
        self._cached_ips: Optional[frozenset[str]] = None
        self._cache_expires_at: float = 0.0
        self._cache_payload_expires_at: float = 0.0
        self._cache_stale_until: float = 0.0
        self._last_refresh_at: float = 0.0
        self._last_error: Optional[str] = None
        self._last_error_at: float = 0.0

    @classmethod
    def init(cls, **kwargs: Any) -> "Gatekeeper":
        """Initializes a Gatekeeper instance. Reads `STRICT_PROXY_*` env vars when omitted."""
        return cls(**kwargs)

    def _log(self, msg: str) -> None:
        if self._logger is not None:
            self._logger(msg)
        else:
            _DEFAULT_LOGGER.warning("%s", msg)

    def _call_http_get_json(
        self, url: str, headers: Optional[Mapping[str, str]] = None
    ) -> dict[str, Any]:
        fn = self._http_get_json
        if headers:
            try:
                sig = inspect.signature(fn)
                params = list(sig.parameters.values())
                accepts_headers = len(params) >= 3 or any(
                    p.kind in (inspect.Parameter.VAR_POSITIONAL, inspect.Parameter.VAR_KEYWORD)
                    for p in params
                )
            except (TypeError, ValueError):
                accepts_headers = False
            if accepts_headers:
                return fn(url, self._fetch_timeout_seconds, headers)
        return fn(url, self._fetch_timeout_seconds)

    def _assert_safe_transport(self, context: str) -> None:
        if (
            self._parsed_url.scheme != "https"
            and not _is_private_or_internal_host(self._parsed_url.hostname)
            and not self._allow_insecure_http
        ):
            raise RuntimeError(
                f"gatekeeper: {context} requires https:// for non-local hosts "
                "(use https://, a local/Docker internal host, or set allow_insecure_http=True)"
            )

    def _verify_signed_ip_payload(self, body: Mapping[str, Any], key_pem: str) -> tuple[frozenset[str], float]:
        key_id = body.get("keyId")
        signature = body.get("signature")
        generated_at = body.get("generatedAt")
        expires_at = body.get("expiresAt")
        ips = body.get("ips")
        if (
            not isinstance(key_id, str)
            or not isinstance(signature, str)
            or not isinstance(generated_at, str)
            or not isinstance(expires_at, str)
            or not isinstance(ips, list)
        ):
            raise RuntimeError("public-ips response malformed")

        payload = {"generatedAt": generated_at, "expiresAt": expires_at, "ips": ips}
        pub_key = load_signing_public_key(key_id, key_pem)
        if not verify_json(pub_key, payload, signature):
            raise RuntimeError("public-ips signature verification failed")

        exp_ts = _parse_iso_timestamp(expires_at)
        if exp_ts is None or exp_ts < time.time():
            raise RuntimeError("public-ips list expired")

        return frozenset(_normalize_ip(str(ip)) for ip in ips), exp_ts

    def _fetch_bootstrap(self) -> tuple[frozenset[str], float]:
        self._assert_safe_transport("api_key bootstrap")
        url = f"{self._controller_base_url}/api/v1/gatekeeper/bootstrap"
        body = self._call_http_get_json(url, headers={"Authorization": f"Bearer {self._api_key}"})
        key_id = body.get("keyId")
        pub_pem = body.get("publicKeyPem")
        if not isinstance(key_id, str) or not isinstance(pub_pem, str):
            raise RuntimeError("gatekeeper bootstrap response missing keyId or publicKeyPem")
        normalized_pem = normalize_pem(pub_pem)
        with self._lock:
            self._discovered_keys = {key_id: normalized_pem}

        if self._pinned_single_key:
            verify_pem: Optional[str] = self._pinned_single_key
        elif self._pinned_keys:
            verify_pem = self._pinned_keys.get(key_id)
        else:
            verify_pem = normalized_pem
        if not verify_pem:
            raise RuntimeError(f"unknown signing key id: {key_id}")
        return self._verify_signed_ip_payload(body, verify_pem)

    def _resolve_keys(self) -> Union[dict[str, str], str]:
        if self._pinned_keys and not self._pinned_single_key:
            return self._pinned_keys
        if self._pinned_single_key:
            return self._pinned_single_key
        with self._lock:
            if self._discovered_keys is not None:
                return self._discovered_keys
        if self._api_key:
            self._get_ip_set()
            with self._lock:
                if self._discovered_keys is not None:
                    return self._discovered_keys
            raise RuntimeError("gatekeeper: bootstrap did not return a controller signing key")
        if not self._auto_fetch_public_key:
            raise RuntimeError("gatekeeper: no public key configured")
        if (
            self._parsed_url.scheme != "https"
            and not _is_loopback_host(self._parsed_url.hostname)
            and not self._allow_insecure_http
        ):
            raise RuntimeError(
                "gatekeeper: auto-fetching the public key requires https:// "
                "(use `api_key`, pin `public_key`, or set `allow_insecure_http=True` for local testing)"
            )
        body = self._call_http_get_json(f"{self._controller_base_url}/api/v1/network/public-key")
        key_id = body.get("keyId")
        pub_pem = body.get("publicKeyPem")
        if not isinstance(key_id, str) or not isinstance(pub_pem, str):
            raise RuntimeError("public-key response missing keyId or publicKeyPem")
        discovered = {key_id: normalize_pem(pub_pem)}
        with self._lock:
            self._discovered_keys = discovered
        return discovered

    def _fetch_ip_set(self) -> tuple[frozenset[str], float]:
        if self._api_key:
            return self._fetch_bootstrap()
        keys = self._resolve_keys()
        body = self._call_http_get_json(f"{self._controller_base_url}/api/v1/network/nodes/public-ips")
        key_id = body.get("keyId")
        if not isinstance(key_id, str):
            raise RuntimeError("public-ips response malformed")
        key_pem = keys if isinstance(keys, str) else keys.get(key_id)
        if not key_pem:
            raise RuntimeError(f"unknown signing key id: {key_id}")
        return self._verify_signed_ip_payload(body, key_pem)

    def _refresh_now(self) -> frozenset[str]:
        with self._fetch_lock:
            try:
                ips, payload_exp = self._fetch_ip_set()
            except Exception as exc:
                with self._lock:
                    self._last_error = str(exc)
                    self._last_error_at = time.time()
                    self._refreshing = False
                raise
            fetched_at = time.time()
            effective_ttl = min(self._cache_ttl_seconds, 15.0) if not ips else self._cache_ttl_seconds
            expires_at = min(fetched_at + effective_ttl, payload_exp)
            stale_until = min(expires_at + self._swr_seconds, payload_exp)
            with self._lock:
                self._cached_ips = ips
                self._cache_expires_at = expires_at
                self._cache_payload_expires_at = payload_exp
                self._cache_stale_until = stale_until
                self._last_refresh_at = fetched_at
                self._last_error = None
                self._last_error_at = 0.0
                self._refreshing = False
            return ips

    def _trigger_background_refresh(self) -> None:
        def _bg() -> None:
            try:
                self._refresh_now()
            except Exception as exc:
                self._log(f"gatekeeper: background refresh failed: {exc}")

        t = threading.Thread(target=_bg, name="strict-proxy-gatekeeper-refresh", daemon=True)
        t.start()

    def _get_ip_set(self, *, force_refresh: bool = False, allow_stale: bool = True) -> frozenset[str]:
        now = time.time()
        trigger_bg = False
        with self._lock:
            if not force_refresh and self._cached_ips is not None:
                if self._cache_expires_at > now:
                    return self._cached_ips
                if allow_stale and self._cache_stale_until > now and self._cache_payload_expires_at > now:
                    if not self._refreshing and (now - self._last_error_at) >= self._failure_backoff_seconds:
                        self._refreshing = True
                        trigger_bg = True
                    cached_stale = self._cached_ips
                else:
                    cached_stale = None
            else:
                cached_stale = None

            if cached_stale is None and not force_refresh:
                if (
                    self._last_error is not None
                    and self._failure_backoff_seconds > 0
                    and (now - self._last_error_at) < self._failure_backoff_seconds
                ):
                    raise RuntimeError(self._last_error)

        if cached_stale is not None:
            if trigger_bg:
                self._trigger_background_refresh()
            return cached_stale

        return self._refresh_now()

    def refresh(self, *, force: bool = False) -> list[str]:
        """Refreshes the signed fleet exit-IP allowlist with anti-stampede cooldown throttling.

        By default (`force=False`), calls within `min_refresh_interval_seconds` (default 30s)
        return the cached list without hitting the controller. Pass `force=True` for explicit
        operator actions (e.g. an admin "Force refresh" button).
        """
        now = time.time()
        if not force:
            with self._lock:
                if (
                    self._cached_ips is not None
                    and self._cache_payload_expires_at > now
                    and (now - self._last_refresh_at) < self._min_refresh_interval_seconds
                ):
                    return sorted(self._cached_ips)
        return sorted(self._get_ip_set(force_refresh=True, allow_stale=False))

    def create_pass_handoff(
        self,
        return_path: str = "/",
        *,
        return_url: Optional[str] = None,
        required_tier: Optional[str] = None,
    ) -> PassHandoffResult:
        """Creates a short-lived, single-use browser plan-pass handoff session (RFC 9126 PAR).

        Redirect the visitor's browser `302` to `result.handoff_url`. After verifying their
        StrictProxy account (zero-click if already signed in), the controller redirects back
        to your site with `?sp_ticket=sp1...`.
        """
        if not self._api_key:
            raise RuntimeError(
                "Gatekeeper.create_pass_handoff() requires `api_key` "
                "(created in Admin -> Links -> Gatekeeper Key Factory)."
            )
        self._assert_safe_transport("pass-session handoff")

        tier = required_tier or (
            self._default_required_tier if self._default_required_tier in ("standard", "pro") else None
        )
        payload: dict[str, Any] = {}
        if return_url:
            payload["returnUrl"] = return_url
        else:
            payload["returnPath"] = safe_return_path(return_path, self._entitlement_query_param)
        if tier:
            payload["requiredTier"] = tier

        url = f"{self._controller_base_url}/api/v1/gatekeeper/pass-session"
        body = self._http_post_json(
            url,
            payload,
            self._fetch_timeout_seconds,
            {"Authorization": f"Bearer {self._api_key}"},
        )
        session_id = body.get("sessionId")
        handoff_url = body.get("handoffUrl")
        expires_in = body.get("expiresIn", 300)
        if not isinstance(session_id, str) or not isinstance(handoff_url, str):
            raise RuntimeError("gatekeeper pass-session response missing sessionId or handoffUrl")
        return PassHandoffResult(
            session_id=session_id,
            handoff_url=handoff_url,
            expires_in=int(expires_in),
        )

    def build_pass_redirect_url(
        self,
        return_path: str = "/",
        *,
        base_url: Optional[str] = None,
        site_key_prefix: Optional[str] = None,
        required_tier: Optional[str] = None,
    ) -> str:
        """Builds a static registered-origin pass redirect URL (`https://<controller>/pass?site=...`)."""
        base = (base_url or self._controller_base_url).rstrip("/")
        prefix = site_key_prefix
        if not prefix and self._api_key:
            m = re.match(r"^(sp_gk_[a-f0-9]{8})_", self._api_key)
            if m:
                prefix = m.group(1)
        if not prefix:
            raise ValueError(
                "Gatekeeper.build_pass_redirect_url() requires `api_key` (sp_gk_...) or explicit `site_key_prefix`."
            )
        params: dict[str, str] = {
            "site": prefix,
            "return": safe_return_path(return_path, self._entitlement_query_param),
        }
        tier = required_tier or (
            self._default_required_tier if self._default_required_tier in ("standard", "pro") else None
        )
        if tier:
            params["tier"] = tier
        return f"{base}/pass?{urllib.parse.urlencode(params)}"

    def status(self) -> dict[str, Any]:
        """Returns current cache, throttle, and diagnostic status."""
        with self._lock:
            cached = sorted(self._cached_ips) if self._cached_ips is not None else []
            exp_iso = (
                datetime.fromtimestamp(self._cache_expires_at, tz=timezone.utc).isoformat().replace("+00:00", "Z")
                if self._cache_expires_at > 0
                else None
            )
            last_ref_iso = (
                datetime.fromtimestamp(self._last_refresh_at, tz=timezone.utc).isoformat().replace("+00:00", "Z")
                if self._last_refresh_at > 0
                else None
            )
            next_allowed_ts = (
                self._last_refresh_at + self._min_refresh_interval_seconds if self._last_refresh_at > 0 else 0.0
            )
            next_allowed_iso = (
                datetime.fromtimestamp(next_allowed_ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")
                if next_allowed_ts > 0
                else None
            )
            last_err = self._last_error
        has_pinned_key = bool(self._pinned_single_key or self._pinned_keys)
        auth_mode = (
            "api-key" if self._api_key else ("pinned-key" if has_pinned_key else "auto-public-key")
        )
        return {
            "controller_url": self._controller_base_url,
            "auth_mode": auth_mode,
            "has_api_key": bool(self._api_key),
            "has_pinned_key": has_pinned_key,
            "cached_ips": cached,
            "cache_expires_at": exp_iso,
            "last_refresh_at": last_ref_iso,
            "next_refresh_allowed_at": next_allowed_iso,
            "last_error": last_err,
        }

    def verify_token(
        self,
        token: Optional[str],
        *,
        now_seconds: Optional[float] = None,
        leeway_seconds: Optional[float] = None,
    ) -> EntitlementVerification:
        """Verifies an `sp1.*` entitlement token offline."""
        keys: Union[dict[str, str], str] = (
            self._pinned_single_key
            if self._pinned_single_key
            else (self._pinned_keys if self._pinned_keys else (self._discovered_keys or {}))
        )
        return verify_entitlement_token(
            token,
            keys,
            now_seconds=now_seconds,
            leeway_seconds=self._entitlement_leeway_seconds if leeway_seconds is None else leeway_seconds,
        )

    def _build_denial(
        self,
        reason: str,
        required_tier: Optional[str] = None,
        actual_tier: Optional[str] = None,
        *,
        ip: Optional[str] = None,
        fetch_error: Optional[str] = None,
        deny_redirect_url: Optional[str] = None,
        had_ticket: bool = False,
    ) -> AuthDecision:
        redirect = deny_redirect_url or self._deny_redirect_url

        if reason == "ip":
            status = 403
            code = "GATEKEEPER_DENIED"
            body: dict[str, Any] = {
                "error": "Access denied: you must be connected through the strict-proxy network.",
                "code": code,
                "hint": "Connect your VPN client and retry.",
            }
        elif reason == "entitlement_missing":
            status = 401
            code = "GATEKEEPER_ENTITLEMENT_REQUIRED"
            body = {
                "error": "This site requires a StrictProxy plan.",
                "code": code,
                "requiredTier": required_tier,
                "hint": "Sign in to the StrictProxy app, fetch /api/v1/entitlement, and send it in the entitlement header.",
            }
        elif reason == "entitlement_invalid":
            status = 401
            code = "GATEKEEPER_ENTITLEMENT_INVALID"
            body = {
                "error": "Your StrictProxy entitlement token is invalid or has expired.",
                "code": code,
                "requiredTier": required_tier,
                "hint": "Refresh your entitlement token and retry.",
            }
        else:
            status = 403
            code = "GATEKEEPER_TIER_INSUFFICIENT"
            body = {
                "error": f"This site requires the {required_tier} plan.",
                "code": code,
                "requiredTier": required_tier,
                "actualTier": actual_tier,
                "hint": f"Upgrade to {required_tier} to access this site.",
            }

        if redirect:
            return AuthDecision(
                allowed=False,
                ip=ip,
                reason=reason,
                status=302,
                code=code,
                body=body,
                redirect_url=redirect,
                fetch_error=fetch_error,
                had_ticket=had_ticket,
            )
        if self._deny_status is not None and self._deny_body is not None:
            return AuthDecision(
                allowed=False,
                ip=ip,
                reason=reason,
                status=self._deny_status,
                code=code,
                body=dict(self._deny_body),
                fetch_error=fetch_error,
                had_ticket=had_ticket,
            )
        return AuthDecision(
            allowed=False,
            ip=ip,
            reason=reason,
            status=status,
            code=code,
            body=body,
            fetch_error=fetch_error,
            had_ticket=had_ticket,
        )

    def auth(
        self,
        *,
        ip: Optional[str] = None,
        headers: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Any]] = None,
        secure: bool = False,
        required_tier: Any = _UNSET,
        set_cookie_from_query: Optional[bool] = None,
        deny_redirect_url: Optional[str] = None,
    ) -> AuthDecision:
        """Authorizes a request against the signed fleet exit-IP list and optional plan tier."""
        effective_tier: Optional[str] = (
            self._default_required_tier if required_tier is _UNSET else required_tier
        )
        effective_set_cookie = (
            self._set_cookie_from_query if set_cookie_from_query is None else set_cookie_from_query
        )

        client_ip = client_ip_of(
            ip,
            headers,
            trust_forwarded_for=self._trust_forwarded_for,
            trusted_proxy_hops=self._trusted_proxy_hops,
        )

        ips: Optional[frozenset[str]] = None
        fetch_error: Optional[str] = None
        try:
            ips = self._get_ip_set()
        except Exception as exc:
            fetch_error = str(exc)
            self._log(f"gatekeeper: ip list refresh failed: {exc}")
            ips = None

        if ips is not None and client_ip and client_ip not in ips and self._refresh_on_unknown_ip:
            with self._lock:
                can_refresh = (time.time() - self._last_refresh_at) >= self._min_refresh_interval_seconds
            if can_refresh:
                try:
                    ips = self._get_ip_set(force_refresh=True, allow_stale=False)
                except Exception:
                    pass

        if ips is None:
            if self._failure_closed:
                return self._build_denial(
                    "ip",
                    effective_tier,
                    ip=client_ip,
                    fetch_error=fetch_error,
                    deny_redirect_url=deny_redirect_url,
                )
            self._log("gatekeeper: fleet IP check unavailable; failure_mode=open allows IP through")
        elif not client_ip or client_ip not in ips:
            return self._build_denial("ip", effective_tier, ip=client_ip, deny_redirect_url=deny_redirect_url)

        user: Optional[EntitlementIdentity] = None
        set_cookie: Optional[str] = None

        if effective_tier is not None:
            had_ticket = _read_query_param(query, self._entitlement_query_param) is not None
            try:
                keys = self._resolve_keys()
            except Exception as exc:
                return self._build_denial(
                    "entitlement_invalid",
                    effective_tier,
                    ip=client_ip,
                    fetch_error=str(exc),
                    deny_redirect_url=deny_redirect_url,
                    had_ticket=had_ticket,
                )
            found = entitlement_token_with_source_of(
                headers,
                query,
                header_name=self._entitlement_header,
                query_param=self._entitlement_query_param,
                cookie_name=self._entitlement_cookie,
            )
            token = found[0] if found else None
            verified = verify_entitlement_token(
                token,
                keys,
                leeway_seconds=self._entitlement_leeway_seconds,
            )
            if not verified.ok or verified.entitlement is None:
                reason = "entitlement_missing" if (verified.reason == "malformed" and not token) else "entitlement_invalid"
                return self._build_denial(
                    reason,
                    effective_tier,
                    ip=client_ip,
                    deny_redirect_url=deny_redirect_url,
                    had_ticket=had_ticket,
                )
            if not tier_satisfies(verified.entitlement.tier, effective_tier):
                return self._build_denial(
                    "tier_insufficient",
                    effective_tier,
                    verified.entitlement.tier,
                    ip=client_ip,
                    deny_redirect_url=deny_redirect_url,
                    had_ticket=had_ticket,
                )
            user = verified.entitlement
            if found and found[1] == "query" and effective_set_cookie:
                proto_hdr = _read_header(headers, "x-forwarded-proto")
                proto = proto_hdr.split(",")[0].strip().lower() if proto_hdr else ""
                is_https = bool(secure) or proto == "https"
                set_cookie = _build_entitlement_cookie(
                    self._entitlement_cookie,
                    found[0],
                    user.expires_at,
                    is_https,
                )

        return AuthDecision(allowed=True, ip=client_ip, user=user, set_cookie=set_cookie)

    # ------------------------------------------------------------------
    # Framework adapters (zero mandatory framework dependencies)
    # ------------------------------------------------------------------

    def asgi_middleware(self, required_tier: Any = _UNSET) -> type:
        """Returns an ASGI middleware class compatible with FastAPI, Starlette, Litestar, and Quart.

        Usage:
            app.add_middleware(gk.asgi_middleware())
        """
        gatekeeper = self

        class StrictProxyASGIMiddleware:
            def __init__(self, app: Any) -> None:
                self.app = app

            async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
                if scope.get("type") != "http":
                    await self.app(scope, receive, send)
                    return

                raw_headers: Sequence[tuple[bytes, bytes]] = scope.get("headers") or ()
                headers: dict[str, str] = {}
                for k_b, v_b in raw_headers:
                    k = k_b.decode("latin-1").lower()
                    v = v_b.decode("latin-1")
                    headers[k] = f"{headers[k]}, {v}" if k in headers else v

                qs = (scope.get("query_string") or b"").decode("latin-1")
                query = urllib.parse.parse_qs(qs, keep_blank_values=False)
                client = scope.get("client")
                remote_ip = client[0] if client else None
                secure = scope.get("scheme") == "https"

                decision = gatekeeper.auth(
                    ip=remote_ip,
                    headers=headers,
                    query=query,
                    secure=secure,
                    required_tier=required_tier,
                )

                if not decision.allowed:
                    if decision.redirect_url:
                        await send(
                            {
                                "type": "http.response.start",
                                "status": 302,
                                "headers": [(b"location", decision.redirect_url.encode("latin-1"))],
                            }
                        )
                        await send({"type": "http.response.body", "body": b""})
                        return
                    payload = json.dumps(decision.body or {}).encode("utf-8")
                    await send(
                        {
                            "type": "http.response.start",
                            "status": decision.status,
                            "headers": [
                                (b"content-type", b"application/json; charset=utf-8"),
                                (b"content-length", str(len(payload)).encode("ascii")),
                            ],
                        }
                    )
                    await send({"type": "http.response.body", "body": payload})
                    return

                state = scope.setdefault("state", {})
                if isinstance(state, dict):
                    state["strict_proxy"] = decision.user

                if not decision.set_cookie:
                    await self.app(scope, receive, send)
                    return

                cookie_bytes = decision.set_cookie.encode("latin-1")

                async def send_with_cookie(message: dict[str, Any]) -> None:
                    if message.get("type") == "http.response.start":
                        hdrs = list(message.get("headers") or ())
                        hdrs.append((b"set-cookie", cookie_bytes))
                        message = {**message, "headers": hdrs}
                    await send(message)

                await self.app(scope, receive, send_with_cookie)

        return StrictProxyASGIMiddleware

    def fastapi_auth(self, required_tier: Any = _UNSET) -> Callable[..., Optional[EntitlementIdentity]]:
        """Returns a FastAPI dependency function for per-route protection.

        Usage:
            @app.get("/pro")
            def pro_route(user = Depends(gk.fastapi_auth("pro"))):
                return {"email": user.email}
        """
        gatekeeper = self

        def _dependency(request: Any, response: Any) -> Optional[EntitlementIdentity]:
            from fastapi import HTTPException  # type: ignore[import-not-found]

            remote_ip = request.client.host if getattr(request, "client", None) else None
            decision = gatekeeper.auth(
                ip=remote_ip,
                headers=dict(request.headers),
                query=dict(request.query_params),
                secure=request.url.scheme == "https",
                required_tier=required_tier,
            )
            if not decision.allowed:
                if decision.redirect_url:
                    raise HTTPException(
                        status_code=302,
                        headers={"Location": decision.redirect_url},
                        detail=decision.body,
                    )
                raise HTTPException(status_code=decision.status, detail=decision.body)
            if decision.set_cookie:
                response.headers.append("set-cookie", decision.set_cookie)
            if hasattr(request, "state"):
                request.state.strict_proxy = decision.user
            return decision.user

        return _dependency

    def flask_auth(self, required_tier: Any = _UNSET) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """Returns a Flask route decorator that sets `flask.g.strict_proxy`.

        Usage:
            @app.route("/members")
            @gk.flask_auth("standard")
            def members():
                return {"email": g.strict_proxy.email}
        """
        gatekeeper = self

        def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
            @wraps(fn)
            def wrapper(*args: Any, **kwargs: Any) -> Any:
                from flask import after_this_request, g, jsonify, redirect, request  # type: ignore[import-not-found]

                decision = gatekeeper.auth(
                    ip=request.remote_addr,
                    headers=request.headers,
                    query=request.args,
                    secure=request.is_secure,
                    required_tier=required_tier,
                )
                if not decision.allowed:
                    if decision.redirect_url:
                        return redirect(decision.redirect_url, code=302)
                    return jsonify(decision.body), decision.status

                g.strict_proxy = decision.user
                if decision.set_cookie:
                    cookie_val = decision.set_cookie

                    @after_this_request
                    def _attach_cookie(resp: Any) -> Any:
                        resp.headers.add("Set-Cookie", cookie_val)
                        return resp

                return fn(*args, **kwargs)

            return wrapper

        return decorator

    def flask_before_request(self, required_tier: Any = _UNSET) -> Callable[[], Any]:
        """Returns a Flask `before_request` hook that protects the entire app."""
        gatekeeper = self

        def _hook() -> Any:
            from flask import after_this_request, g, jsonify, redirect, request  # type: ignore[import-not-found]

            decision = gatekeeper.auth(
                ip=request.remote_addr,
                headers=request.headers,
                query=request.args,
                secure=request.is_secure,
                required_tier=required_tier,
            )
            if not decision.allowed:
                if decision.redirect_url:
                    return redirect(decision.redirect_url, code=302)
                return jsonify(decision.body), decision.status

            g.strict_proxy = decision.user
            if decision.set_cookie:
                cookie_val = decision.set_cookie

                @after_this_request
                def _attach_cookie(resp: Any) -> Any:
                    resp.headers.add("Set-Cookie", cookie_val)
                    return resp

            return None

        return _hook

    def django_auth(self, required_tier: Any = _UNSET) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """Returns a Django view decorator that sets `request.strict_proxy`."""
        gatekeeper = self

        def decorator(view_fn: Callable[..., Any]) -> Callable[..., Any]:
            @wraps(view_fn)
            def wrapper(request: Any, *args: Any, **kwargs: Any) -> Any:
                from django.http import HttpResponseRedirect, JsonResponse  # type: ignore[import-not-found]

                decision = gatekeeper.auth(
                    ip=request.META.get("REMOTE_ADDR"),
                    headers=request.headers,
                    query=request.GET,
                    secure=request.is_secure(),
                    required_tier=required_tier,
                )
                if not decision.allowed:
                    if decision.redirect_url:
                        return HttpResponseRedirect(decision.redirect_url)
                    return JsonResponse(decision.body or {}, status=decision.status)

                request.strict_proxy = decision.user
                response = view_fn(request, *args, **kwargs)
                if decision.set_cookie:
                    response.headers["Set-Cookie"] = decision.set_cookie
                return response

            return wrapper

        return decorator

    def wsgi_middleware(self, app: Any, required_tier: Any = _UNSET) -> Callable[[dict[str, Any], Any], Any]:
        """Wraps any WSGI application (Flask, Django, Pyramid, Bottle)."""
        gatekeeper = self

        def wsgi_app(environ: dict[str, Any], start_response: Any) -> Any:
            headers: dict[str, str] = {}
            for k, v in environ.items():
                if k.startswith("HTTP_"):
                    headers[k[5:].replace("_", "-").lower()] = str(v)
            query = urllib.parse.parse_qs(environ.get("QUERY_STRING", ""), keep_blank_values=False)
            decision = gatekeeper.auth(
                ip=environ.get("REMOTE_ADDR"),
                headers=headers,
                query=query,
                secure=environ.get("wsgi.url_scheme") == "https",
                required_tier=required_tier,
            )
            if not decision.allowed:
                if decision.redirect_url:
                    start_response("302 Found", [("Location", decision.redirect_url)])
                    return [b""]
                payload = json.dumps(decision.body or {}).encode("utf-8")
                reason_phrase = "Unauthorized" if decision.status == 401 else "Forbidden"
                start_response(
                    f"{decision.status} {reason_phrase}",
                    [
                        ("Content-Type", "application/json; charset=utf-8"),
                        ("Content-Length", str(len(payload))),
                    ],
                )
                return [payload]

            environ["strict_proxy.user"] = decision.user
            if not decision.set_cookie:
                return app(environ, start_response)

            cookie_val = decision.set_cookie

            def custom_start_response(status: str, response_headers: list[tuple[str, str]], exc_info: Any = None) -> Any:
                return start_response(status, [*response_headers, ("Set-Cookie", cookie_val)], exc_info)

            return app(environ, custom_start_response)

        return wsgi_app
