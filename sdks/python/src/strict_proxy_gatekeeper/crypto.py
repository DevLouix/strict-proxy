"""Cryptographic helpers for StrictProxy Gatekeeper (Ed25519 + canonical JSON)."""

from __future__ import annotations

import base64
import json
import threading
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_pem_public_key

_key_cache_lock = threading.Lock()
_key_cache: dict[str, Ed25519PublicKey] = {}


def canonical_json(payload: Any) -> str:
    """Deterministic canonical JSON matching `@strict-proxy/types` and `@strict-proxy/gatekeeper`.

    Object keys are sorted lexicographically, whitespace is omitted, and UTF-8
    characters are preserved verbatim (matching JavaScript's `JSON.stringify`).
    """
    if payload is None or isinstance(payload, (bool, int, float, str)):
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if isinstance(payload, (list, tuple)):
        return "[" + ",".join(canonical_json(item) for item in payload) + "]"
    if isinstance(payload, dict):
        items = sorted(payload.items(), key=lambda kv: str(kv[0]))
        parts = [
            f"{json.dumps(str(k), ensure_ascii=False)}:{canonical_json(v)}"
            for k, v in items
        ]
        return "{" + ",".join(parts) + "}"
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def normalize_pem(raw: str) -> str:
    """Normalizes PEM text from env vars where newlines may be escaped as literal `\n` or quoted."""
    s = raw.strip()
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        s = s[1:-1].strip()
    s = s.replace("\\r\\n", "\n").replace("\\n", "\n").replace("\r\n", "\n")
    return s


def load_signing_public_key(cache_key: str, public_key_pem: str) -> Ed25519PublicKey:
    """Loads and caches an Ed25519 SPKI public key from PEM text."""
    normalized = normalize_pem(public_key_pem)
    composite = f"{cache_key}\n{normalized}"
    with _key_cache_lock:
        cached = _key_cache.get(composite)
        if cached is not None:
            return cached
    key = load_pem_public_key(normalized.encode("utf-8"))
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError("Gatekeeper public key must be an Ed25519 public key")
    with _key_cache_lock:
        _key_cache[composite] = key
    return key


def verify_json(public_key: Ed25519PublicKey, payload: Any, signature_b64: str) -> bool:
    """Verifies an Ed25519 canonical-JSON signature; safe for untrusted input."""
    try:
        raw_sig = base64.b64decode(signature_b64, validate=True)
        public_key.verify(raw_sig, canonical_json(payload).encode("utf-8"))
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


def b64url_decode(segment: str) -> bytes:
    """Decodes an unpadded base64url segment."""
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)
