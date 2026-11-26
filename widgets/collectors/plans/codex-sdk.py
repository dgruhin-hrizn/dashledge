"""Read only the signed-in ChatGPT account's subscription windows, plan and banked resets."""
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
        return summary(response)


def summary(response):
    plan = response.rate_limits.plan_type
    return {
        "groups": quota_groups(response),
        "planType": getattr(plan, "value", plan),
        "resetCredits": reset_credits(response),
    }


def reset_credits(response):
    """How many free limit resets are waiting; never their IDs or descriptions."""
    banked = response.rate_limit_reset_credits
    count = getattr(banked, "available_count", None) if banked is not None else None
    return count if isinstance(count, int) and count >= 0 else 0


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
            groups[key]["planType"] = raw.get("planType")
            groups[key]["rateLimitReachedType"] = raw.get("rateLimitReachedType")
    if "codex" not in groups and response.rate_limits.limit_id in (None, "codex"):
        groups["codex"] = response.rate_limits.model_dump(
            mode="json", by_alias=True, include={"primary", "secondary", "limit_name", "plan_type", "rate_limit_reached_type"})
    return groups


if __name__ == "__main__":
    print(json.dumps(limits(sys.argv[1])))
