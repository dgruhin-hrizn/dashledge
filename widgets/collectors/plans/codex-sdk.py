"""Read only the signed-in ChatGPT account's subscription windows."""
import json
import sys

from openai_codex.client import CodexClient, CodexConfig
from openai_codex.generated.v2_all import GetAccountRateLimitsResponse


def limits(binary):
    config = CodexConfig(codex_bin=binary, client_name="dashledge", client_title="Dashledge")
    with CodexClient(config) as client:
        client.initialize()
        account = client.account_read({"refreshToken": False}).account
        if account is None or account.root.type != "chatgpt":
            return {"signedOut": True}
        response = client.request("account/rateLimits/read", None, response_model=GetAccountRateLimitsResponse)
        groups = response.rate_limits_by_limit_id or {"codex": response.rate_limits}
        return {"groups": {
            key: group.model_dump(mode="json", by_alias=True, include={"primary", "secondary", "limit_name"})
            for key, group in groups.items()
        }}


if __name__ == "__main__":
    print(json.dumps(limits(sys.argv[1])))
