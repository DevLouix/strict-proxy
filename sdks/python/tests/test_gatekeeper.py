"""Unit tests for the StrictProxy Gatekeeper Python SDK."""

from __future__ import annotations

import asyncio
import base64
import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from strict_proxy_gatekeeper import (
    Gatekeeper,
    canonical_json,
    client_ip_of,
    entitlement_token_of,
    safe_return_path,
    tier_satisfies,
    verify_entitlement_token,
)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _sign_json(private_key: Ed25519PrivateKey, payload: Any) -> str:
    sig = private_key.sign(canonical_json(payload).encode("utf-8"))
    return base64.b64encode(sig).decode("ascii")


def _make_signed_materials(
    *,
    key_id: str = "primary",
    ips: list[str] | None = None,
    tier: str = "pro",
    expired: bool = False,
) -> dict[str, Any]:
    priv = Ed25519PrivateKey.generate()
    pub_pem = (
        priv.public_key()
        .public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode("utf-8")
    )
    now = datetime.now(timezone.utc)
    exp = now - timedelta(minutes=5) if expired else now + timedelta(minutes=10)
    ips_payload = {
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "expiresAt": exp.isoformat().replace("+00:00", "Z"),
        "ips": ips if ips is not None else ["203.0.113.10"],
    }
    public_ips_body = {
        **ips_payload,
        "keyId": key_id,
        "signature": _sign_json(priv, ips_payload),
    }
    claims = {
        "version": 1,
        "keyId": key_id,
        "sub": "user-42",
        "email": "member@example.com",
        "tier": tier,
        "status": "active",
        "currentPeriodEnd": (now + timedelta(days=30)).isoformat().replace("+00:00", "Z"),
        "issuedAt": now.isoformat().replace("+00:00", "Z"),
        "expiresAt": exp.isoformat().replace("+00:00", "Z"),
    }
    claims_b64 = _b64url(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
    sig_raw = base64.b64decode(_sign_json(priv, claims))
    token = f"sp1.{claims_b64}.{_b64url(sig_raw)}"
    return {
        "public_key_pem": pub_pem,
        "public_ips_body": public_ips_body,
        "public_key_body": {
            "keyId": key_id,
            "algorithm": "Ed25519",
            "publicKeyPem": pub_pem,
            "publicIpsPath": "/api/v1/network/nodes/public-ips",
        },
        "token": token,
    }


def test_canonical_json_sorts_keys_deterministically() -> None:
    assert canonical_json({"b": 1, "a": {"z": True, "m": None}}) == '{"a":{"m":null,"z":true},"b":1}'


def test_tier_hierarchy() -> None:
    assert tier_satisfies("pro", "standard")
    assert tier_satisfies("standard", "standard")
    assert not tier_satisfies("standard", "pro")
    assert not tier_satisfies("free", "standard")


def test_client_ip_extraction_and_trusted_proxy_hops() -> None:
    assert client_ip_of("::ffff:203.0.113.7", trust_forwarded_for=False) == "203.0.113.7"
    assert (
        client_ip_of(
            "127.0.0.1",
            {"X-Forwarded-For": "198.51.100.99, ::ffff:203.0.113.10"},
            trust_forwarded_for=True,
            trusted_proxy_hops=1,
        )
        == "203.0.113.10"
    )
    assert (
        client_ip_of(
            "127.0.0.1",
            {"X-Forwarded-For": "198.51.100.99, 203.0.113.10, 10.0.0.2"},
            trust_forwarded_for=True,
            trusted_proxy_hops=2,
        )
        == "203.0.113.10"
    )


def test_entitlement_token_priority_header_query_cookie() -> None:
    assert (
        entitlement_token_of(
            {"x-strict-proxy-entitlement": "sp1.h.s", "cookie": "sp_entitlement=sp1.c.s"},
            {"sp_ticket": "sp1.q.s"},
        )
        == "sp1.h.s"
    )
    assert (
        entitlement_token_of({"cookie": "sp_entitlement=sp1.c.s"}, {"sp_ticket": "sp1.q.s"})
        == "sp1.q.s"
    )
    assert entitlement_token_of({"cookie": "a=1; sp_entitlement=sp1.c.s; b=2"}) == "sp1.c.s"


def test_gatekeeper_init_and_auth_proxy_only_and_plan_gated() -> None:
    m = _make_signed_materials(key_id="k1", tier="standard")

    def fake_get(url: str, _timeout: float) -> dict[str, Any]:
        assert url == "https://controller.test/api/v1/network/nodes/public-ips"
        return m["public_ips_body"]

    gk = Gatekeeper.init(
        controller_url="https://controller.test/",
        public_key=m["public_key_pem"],
        trust_forwarded_for=True,
        trusted_proxy_hops=1,
        http_get_json=fake_get,
    )

    # Non-proxy IP is denied
    denied_ip = gk.auth(ip="127.0.0.1", headers={"x-forwarded-for": "198.51.100.99"})
    assert not denied_ip.allowed
    assert denied_ip.status == 403
    assert denied_ip.code == "GATEKEEPER_DENIED"

    # Proxy-only mode admits any traffic exiting a fleet IP
    allowed_proxy = gk.auth(
        ip="127.0.0.1",
        headers={"x-forwarded-for": "198.51.100.99, 203.0.113.10"},
    )
    assert allowed_proxy.allowed
    assert allowed_proxy.ip == "203.0.113.10"
    assert allowed_proxy.user is None

    # Plan-gated route admits standard token via ?sp_ticket= and issues HttpOnly Secure cookie
    allowed_member = gk.auth(
        ip="127.0.0.1",
        headers={
            "x-forwarded-for": "198.51.100.99, 203.0.113.10",
            "x-forwarded-proto": "https",
        },
        query={"sp_ticket": m["token"]},
        required_tier="standard",
    )
    assert allowed_member.allowed
    assert allowed_member.user is not None
    assert allowed_member.user.email == "member@example.com"
    assert allowed_member.user.tier == "standard"
    assert allowed_member.set_cookie is not None
    assert "HttpOnly" in allowed_member.set_cookie
    assert "SameSite=Lax" in allowed_member.set_cookie
    assert "Secure" in allowed_member.set_cookie

    # Pro route denies standard user with 403 GATEKEEPER_TIER_INSUFFICIENT
    denied_tier = gk.auth(
        ip="203.0.113.10",
        headers={"x-strict-proxy-entitlement": m["token"]},
        required_tier="pro",
    )
    assert not denied_tier.allowed
    assert denied_tier.status == 403
    assert denied_tier.code == "GATEKEEPER_TIER_INSUFFICIENT"


def test_auto_fetch_public_key_over_https_and_reject_remote_http() -> None:
    m = _make_signed_materials(key_id="rot-2026")

    def fake_get(url: str, _timeout: float) -> dict[str, Any]:
        if url.endswith("/api/v1/network/public-key"):
            return m["public_key_body"]
        return m["public_ips_body"]

    gk_https = Gatekeeper.init(
        controller_url="https://controller.test",
        required_tier="standard",
        http_get_json=fake_get,
    )
    res = gk_https.auth(ip="203.0.113.10", headers={"x-strict-proxy-entitlement": m["token"]})
    assert res.allowed
    assert res.user is not None and res.user.tier == "pro"

    # Non-localhost plain http:// without pinned public_key must fail closed
    gk_http = Gatekeeper.init(
        controller_url="http://controller.test",
        http_get_json=fake_get,
    )
    denied = gk_http.auth(ip="203.0.113.10")
    assert not denied.allowed
    assert denied.status == 403


def test_expired_token_rejected() -> None:
    m = _make_signed_materials(expired=True)
    res = verify_entitlement_token(m["token"], m["public_key_pem"])
    assert not res.ok
    assert res.reason == "expired"


def test_env_var_init(monkeypatch: pytest.MonkeyPatch) -> None:
    m = _make_signed_materials()
    monkeypatch.setenv("STRICT_PROXY_CONTROLLER_URL", "https://controller.test")
    monkeypatch.setenv("STRICT_PROXY_PUBLIC_KEY_PEM", m["public_key_pem"])
    gk = Gatekeeper.init(http_get_json=lambda _u, _t: m["public_ips_body"])
    assert gk.refresh() == ["203.0.113.10"]


def test_asgi_and_wsgi_middleware() -> None:
    m = _make_signed_materials(tier="pro")
    gk = Gatekeeper.init(
        controller_url="https://controller.test",
        public_key=m["public_key_pem"],
        required_tier="standard",
        http_get_json=lambda _u, _t: m["public_ips_body"],
    )

    # ASGI middleware test
    async def inner_asgi(scope: dict[str, Any], _receive: Any, send: Any) -> None:
        user = scope["state"]["strict_proxy"]
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": user.email.encode("utf-8")})

    wrapped_asgi = gk.asgi_middleware()(inner_asgi)
    sent: list[dict[str, Any]] = []

    async def fake_send(msg: dict[str, Any]) -> None:
        sent.append(msg)

    scope = {
        "type": "http",
        "scheme": "https",
        "client": ("203.0.113.10", 54321),
        "headers": [],
        "query_string": f"sp_ticket={m['token']}".encode("ascii"),
    }
    asyncio.run(wrapped_asgi(scope, None, fake_send))
    assert sent[0]["status"] == 200
    assert any(k == b"set-cookie" for k, _ in sent[0]["headers"])
    assert sent[1]["body"] == b"member@example.com"

    # WSGI middleware test (denied IP)
    captured: dict[str, Any] = {}

    def start_response(status: str, headers: list[tuple[str, str]], _exc: Any = None) -> None:
        captured["status"] = status
        captured["headers"] = headers

    wsgi = gk.wsgi_middleware(lambda _env, _sr: [b"ok"])
    body = b"".join(wsgi({"REMOTE_ADDR": "198.51.100.5", "QUERY_STRING": ""}, start_response))
    assert captured["status"].startswith("403")
    assert json.loads(body)["code"] == "GATEKEEPER_DENIED"


def test_escaped_pem_ip_port_and_status() -> None:
    m = _make_signed_materials()
    escaped_pem = '"' + m["public_key_pem"].replace("\n", "\\n") + '"'
    gk = Gatekeeper.init(
        controller_url="https://controller.test/#links",
        public_key=escaped_pem,
        trust_forwarded_for=True,
        trusted_proxy_hops=1,
        http_get_json=lambda _u, _t: m["public_ips_body"],
    )
    ok = gk.auth(ip="127.0.0.1", headers={"x-forwarded-for": "198.51.100.99, 203.0.113.10:54321"})
    assert ok.allowed
    assert ok.ip == "203.0.113.10"
    st = gk.status()
    assert st["last_error"] is None
    assert st["cached_ips"] == ["203.0.113.10"]


def test_api_key_bootstrap_and_status() -> None:
    materials = _make_signed_materials(ips=["203.0.113.55"], tier="pro")
    pub_pem = materials["public_key_pem"]
    ips_body = materials["public_ips_body"]
    token = materials["token"]
    seen_headers: dict[str, str] = {}
    seen_url: list[str] = []

    def fake_get(url: str, timeout: float, headers: dict[str, str] | None = None) -> dict:
        seen_url.append(url)
        if headers:
            seen_headers.update(headers)
        return {
            "site": {"id": "s1", "name": "Portal", "keyPrefix": "sp_gk_deadbeef"},
            "algorithm": "Ed25519",
            "publicKeyPem": pub_pem,
            **ips_body,
        }

    gk = Gatekeeper.init(
        controller_url="https://controller.test",
        api_key="sp_gk_deadbeef_0123456789abcdefghijklmnopqrstuvwxyz",
        required_tier="pro",
        http_get_json=fake_get,
    )
    decision = gk.auth(ip="203.0.113.55", headers={"x-strict-proxy-entitlement": token})
    assert decision.allowed is True
    assert decision.user is not None and decision.user.tier == "pro"
    assert seen_url == ["https://controller.test/api/v1/gatekeeper/bootstrap"]
    assert seen_headers.get("Authorization") == "Bearer sp_gk_deadbeef_0123456789abcdefghijklmnopqrstuvwxyz"
    st = gk.status()
    assert st["auth_mode"] == "api-key"
    assert st["has_api_key"] is True
    assert st["cached_ips"] == ["203.0.113.55"]


def test_rejects_node_key_or_site_key_in_public_key() -> None:
    with pytest.raises(ValueError, match="api_key"):
        Gatekeeper.init(
            controller_url="https://controller.test",
            public_key="sp_gk_deadbeef_0123456789abcdefghijklmnopqrstuvwxyz",
        )
    with pytest.raises(ValueError, match="not a proxy node public key"):
        Gatekeeper.init(
            controller_url="https://controller.test",
            public_key="m4h5s8W2kQp9L1xYz0AbCdEfGhIjKlMnOpQrStUvWxY=",
        )


def test_safe_return_path_blocks_open_redirects_and_strips_ticket() -> None:
    assert safe_return_path("/wallet?tab=1&sp_ticket=old") == "/wallet?tab=1"
    assert safe_return_path("/dashboard") == "/dashboard"
    assert safe_return_path("//evil.example/pwn") == "/"
    assert safe_return_path("https://evil.example/pwn") == "/"
    assert safe_return_path("/\\evil.example") == "/"
    assert safe_return_path("/foo\r\nSet-Cookie: a=1") == "/"
    assert safe_return_path(None) == "/"


def test_refresh_cooldown_throttling_and_force_override() -> None:
    m1 = _make_signed_materials(ips=["203.0.113.10"])
    m2 = _make_signed_materials(ips=["203.0.113.10", "203.0.113.20"])
    # Reuse keypair from m1 for second response
    calls = 0

    def fake_get(_url: str, _timeout: float) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        return m1["public_ips_body"]

    gk = Gatekeeper.init(
        controller_url="https://controller.test",
        public_key=m1["public_key_pem"],
        cache_ttl_seconds=300,
        min_refresh_interval_seconds=60,
        http_get_json=fake_get,
    )
    assert gk.refresh() == ["203.0.113.10"]
    assert calls == 1
    # Within cooldown -> returns cached IPs without re-fetching
    assert gk.refresh() == ["203.0.113.10"]
    assert calls == 1
    # Explicit force=True bypasses cooldown
    assert gk.refresh(force=True) == ["203.0.113.10"]
    assert calls == 2
    st = gk.status()
    assert st["last_refresh_at"] is not None
    assert st["next_refresh_allowed_at"] is not None


def test_failure_backoff_prevents_retry_storm() -> None:
    m = _make_signed_materials()
    calls = 0

    def failing_get(_url: str, _timeout: float) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        raise RuntimeError("controller unreachable")

    gk = Gatekeeper.init(
        controller_url="https://controller.test",
        public_key=m["public_key_pem"],
        failure_backoff_seconds=30,
        http_get_json=failing_get,
    )
    d1 = gk.auth(ip="203.0.113.10")
    d2 = gk.auth(ip="203.0.113.10")
    assert not d1.allowed and d1.fetch_error == "controller unreachable"
    assert not d2.allowed and d2.fetch_error == "controller unreachable"
    assert calls == 1


def test_pass_handoff_and_had_ticket_loop_guard() -> None:
    m = _make_signed_materials(ips=["203.0.113.10"], tier="standard")
    posted: list[tuple[str, dict[str, Any], dict[str, str]]] = []

    def fake_get(_url: str, _timeout: float, _headers: dict[str, str] | None = None) -> dict[str, Any]:
        return {
            "site": {"id": "s1", "name": "Portal", "keyPrefix": "sp_gk_deadbeef"},
            "algorithm": "Ed25519",
            "publicKeyPem": m["public_key_pem"],
            **m["public_ips_body"],
        }

    def fake_post(
        url: str, payload: dict[str, Any], _timeout: float, headers: dict[str, str] | None = None
    ) -> dict[str, Any]:
        posted.append((url, dict(payload), dict(headers or {})))
        return {
            "sessionId": "sess-123",
            "handoffUrl": "https://strictproxy.example.com/pass/sess-123",
            "expiresIn": 300,
        }

    gk = Gatekeeper.init(
        controller_url="https://controller.test",
        api_key="sp_gk_deadbeef_0123456789abcdefghijklmnopqrstuvwxyz",
        required_tier="standard",
        http_get_json=fake_get,
        http_post_json=fake_post,
    )

    # Pass-less visit -> had_ticket is False
    d_missing = gk.auth(ip="203.0.113.10")
    assert not d_missing.allowed
    assert d_missing.code == "GATEKEEPER_ENTITLEMENT_REQUIRED"
    assert d_missing.had_ticket is False

    # Bogus ?sp_ticket=... -> had_ticket is True (use to avoid redirect loop)
    d_bad = gk.auth(ip="203.0.113.10", query={"sp_ticket": "bogus"})
    assert not d_bad.allowed
    assert d_bad.code == "GATEKEEPER_ENTITLEMENT_INVALID"
    assert d_bad.had_ticket is True

    # RFC 9126 PAR pass handoff
    handoff = gk.create_pass_handoff("/wallet?sp_ticket=old&tab=2")
    assert handoff.session_id == "sess-123"
    assert handoff.handoff_url == "https://strictproxy.example.com/pass/sess-123"
    assert handoff.expires_in == 300
    assert posted[0][0] == "https://controller.test/api/v1/gatekeeper/pass-session"
    assert posted[0][1] == {"returnPath": "/wallet?tab=2", "requiredTier": "standard"}
    assert posted[0][2]["Authorization"] == "Bearer sp_gk_deadbeef_0123456789abcdefghijklmnopqrstuvwxyz"

    # Static registered-origin redirect URL
    static_url = gk.build_pass_redirect_url("//evil.test/pwn")
    assert static_url == "https://controller.test/pass?site=sp_gk_deadbeef&return=%2F&tier=standard"
