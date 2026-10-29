"""Authenticated publication only. No private key, operator credential or transaction use."""
from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request


class PublicationError(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def origin(api):
    parsed = urllib.parse.urlsplit(api)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise PublicationError("Use a canonical API origin without credentials or a path")
    if not ((parsed.scheme == "https" and parsed.netloc in ("api.agentizable.ai", "api.agentbounties.app"))
            or (parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1"))):
        raise PublicationError("Unsupported publication API origin")
    return api.rstrip("/")


def request(api, path, token, body=None, key=None):
    headers = {"Content-Type": "application/json", "Authorization": "Bearer " + token}
    if key is not None:
        headers["Idempotency-Key"] = key
    req = urllib.request.Request(origin(api) + path, data=canonical(body) if body is not None else None,
                                 headers=headers, method="POST" if body is not None else "GET")
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=30) as response:
            raw = response.read(512 * 1024 + 1)
            if len(raw) > 512 * 1024:
                raise PublicationError("Publication response exceeds the supported size")
            return response.status, json.loads(raw)
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read(65536))
        except (ValueError, UnicodeError):
            payload = {}
        return error.code, payload
    except (OSError, ValueError) as error:
        raise PublicationError("Publication status unavailable; keep the same document and key. No automatic retry.") from None


def require_creator_session(api, creator, chain_id=8453):
    token = os.environ.get("TERMS_CREATOR_SESSION_TOKEN", "")
    if not re.fullmatch(r"abws_[0-9a-f]{64}", token):
        raise PublicationError("TERMS_CREATOR_SESSION_TOKEN must be a current verified creator wallet session; keeper/operator keys do not qualify")
    status, result = request(api, "/v1/auth/session", token)
    principal = result.get("principal", {}) if isinstance(result, dict) else {}
    if status != 200 or principal.get("kind") != "wallet" or principal.get("chain_id") != chain_id or str(principal.get("address", "")).lower() != creator.lower():
        raise PublicationError("The publication session does not prove this exact creator wallet and network")
    return token


def validate_record(record, creator, document):
    # Existing tooling already uses this exact Keccak implementation. Import
    # lazily so planning-only commands do not need its native dependency.
    from _shared.evm import keccak256
    if not isinstance(record, dict) or str(record.get("creator_wallet", "")).lower() != creator.lower() or canonical(record.get("document")) != canonical(document):
        raise PublicationError("Published content or creator differs from the reviewed document")
    for field, value in (("terms_hash", document), ("policy_hash", document["verification_policy"]),
                         ("acceptance_criteria_hash", document["acceptance_criteria"]),
                         ("benchmark_hash", document["benchmark"]), ("evidence_schema_hash", document["evidence_schema"])):
        if record.get(field) != keccak256(canonical(value)):
            raise PublicationError("Published commitment differs from the reviewed content: " + field)
    return record


def publish_terms(api, creator, document):
    network = document.get("contract_terms", {}).get("network")
    chain_id = 8453 if network in ("Base", "base-mainnet") else 84532 if network in ("BaseSepolia", "base-sepolia") else None
    if chain_id is None:
        raise PublicationError("Unsupported publication network")
    token = require_creator_session(api, creator, chain_id)
    body = {"creator_wallet": creator, "document": document}
    key = "activation-terms-v1-" + hashlib.sha256(canonical(body)).hexdigest()
    status, result = request(api, "/v1/base/autonomous-bounties/terms", token, body, key)
    if status == 409 and isinstance(result, dict) and result.get("error_code") == "publication_already_exists":
        path = result.get("next_action_url", "")
        if not re.fullmatch(r"/v1/base/autonomous-bounties/terms/0x[0-9a-f]{64}", path):
            raise PublicationError("Existing publication reference is invalid")
        read_status, record = request(api, path, token)
        if read_status != 200:
            raise PublicationError("Existing publication could not be read; activation stopped")
        validate_record(record, creator, document)
        if not path.endswith("/" + record["terms_hash"]):
            raise PublicationError("Existing publication identity mismatch")
        raise PublicationError("Exact existing terms verified at " + path + "; review the original publication receipt before explicitly resuming activation. No automatic signing or funding.")
    if status != 200:
        code = result.get("error_code") if isinstance(result, dict) else None
        safe_code = code if isinstance(code, str) and re.fullmatch(r"[a-z_]{1,80}", code) else "publication_unavailable"
        raise PublicationError(f"Publication stopped: HTTP {status} {safe_code}. Keep the exact document and stable key.")
    return validate_record(result, creator, document)
