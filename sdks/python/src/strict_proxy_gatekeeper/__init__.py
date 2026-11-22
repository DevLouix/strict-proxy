"""Official StrictProxy Gatekeeper SDK for Python."""

from .crypto import canonical_json, load_signing_public_key, normalize_pem, verify_json
from .gatekeeper import (
    TIER_RANK,
    AuthDecision,
    EntitlementIdentity,
    EntitlementVerification,
    Gatekeeper,
    client_ip_of,
    entitlement_token_of,
    entitlement_token_with_source_of,
    tier_satisfies,
    verify_entitlement_token,
)

__version__ = "0.1.1"

__all__ = [
    "__version__",
    "AuthDecision",
    "EntitlementIdentity",
    "EntitlementVerification",
    "Gatekeeper",
    "TIER_RANK",
    "canonical_json",
    "client_ip_of",
    "entitlement_token_of",
    "entitlement_token_with_source_of",
    "load_signing_public_key",
    "normalize_pem",
    "tier_satisfies",
    "verify_entitlement_token",
    "verify_json",
]
