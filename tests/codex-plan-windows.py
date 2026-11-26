"""Exercise the pinned SDK's real response type with both supported bucket formats."""
import runpy
from pathlib import Path

from openai_codex.generated.v2_all import GetAccountRateLimitsResponse

reader = Path(__file__).resolve().parents[1] / "widgets/collectors/plans/codex-sdk.py"
quota_groups = runpy.run_path(str(reader))["quota_groups"]
legacy = {"primary": {"usedPercent": 9}}
response = GetAccountRateLimitsResponse.model_validate({
    "rateLimits": legacy,
    "rateLimitsByLimitId": {
        "codex": {"primary": {"usedPercent": 0}, "planType": "future-plan"},
        "review": {"limitName": "Review", "secondary": {"usedPercent": 75}},
    },
})
groups = quota_groups(response)
assert groups["codex"]["primary"]["usedPercent"] == 0
assert groups["review"]["secondary"]["usedPercent"] == 75
assert groups["review"]["limitName"] == "Review"
assert quota_groups(GetAccountRateLimitsResponse.model_validate({"rateLimits": legacy}))["codex"]["primary"]["usedPercent"] == 9
