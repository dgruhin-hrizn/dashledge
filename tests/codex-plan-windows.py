"""Exercise the pinned SDK's real response type with both supported bucket formats."""
import runpy
from pathlib import Path

from openai_codex.generated.v2_all import GetAccountRateLimitsResponse

reader = runpy.run_path(str(Path(__file__).resolve().parents[1] / "widgets/packages/plans/collector/codex-sdk.py"))
quota_groups, summary = reader["quota_groups"], reader["summary"]
legacy = {"primary": {"usedPercent": 9}}
response = GetAccountRateLimitsResponse.model_validate({
    "rateLimits": {**legacy, "planType": "pro"},
    "rateLimitsByLimitId": {
        "codex": {"primary": {"usedPercent": 0}, "planType": "future-plan"},
        "review": {"limitName": "Review", "secondary": {"usedPercent": 75}, "rateLimitReachedType": "secondary"},
    },
    "rateLimitResetCredits": {"availableCount": 2, "credits": []},
})
groups = quota_groups(response)
assert groups["codex"]["primary"]["usedPercent"] == 0
assert groups["codex"]["planType"] == "future-plan"
assert groups["review"]["secondary"]["usedPercent"] == 75
assert groups["review"]["limitName"] == "Review"
assert groups["review"]["rateLimitReachedType"] == "secondary"
assert quota_groups(GetAccountRateLimitsResponse.model_validate({"rateLimits": legacy}))["codex"]["primary"]["usedPercent"] == 9

result = summary(response)
assert result["planType"] == "pro"
assert result["resetCredits"] == 2
bare = summary(GetAccountRateLimitsResponse.model_validate({"rateLimits": legacy}))
assert bare["planType"] is None and bare["resetCredits"] == 0
