"""Read only the signed-in ChatGPT account's subscription windows."""
import json
import sys

from openai_codex.client import CodexClient, CodexConfig
from openai_codex.generated.v2_all import GetAccountRateLimitsResponse, RateLimitSnapshot


def limits(binary):
    config = CodexConfig(codex_bin=binary, client_name="dashledge", client_title="Dashledge")
    with CodexClient(config) as client:
        client.initialize()
        account = client.account_read({"refreshToken": False}).account
        if account is None or account.root.type != "chatgpt":
            return {"signedOut": True}
        response = client.request("account/rateLimits/read", None, response_model=GetAccountRateLimitsResponse)
        return {"groups": quota_groups(response)}


def quota_groups(response):
    groups = {}
    for key, raw in (response.rate_limits_by_limit_id or {}).items():
        # The generated multi-bucket field is dict[str, Any], even in typed SDK responses.
        if not isinstance(raw, dict):
            continue
        windows = {slot: raw.get(slot) for slot in ("primary", "secondary") if isinstance(raw.get(slot), dict)}
        if windows:
            snapshot = RateLimitSnapshot.model_validate(windows)
            groups[key] = snapshot.model_dump(mode="json", by_alias=True, include={"primary", "secondary"})
            groups[key]["limitName"] = raw.get("limitName")
    if "codex" not in groups and response.rate_limits.limit_id in (None, "codex"):
        groups["codex"] = response.rate_limits.model_dump(mode="json", by_alias=True, include={"primary", "secondary", "limit_name"})
    return groups


if __name__ == "__main__":
    print(json.dumps(limits(sys.argv[1])))
