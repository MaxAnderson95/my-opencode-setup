# Jev through OpenRouter

Use this route when the application must authenticate, bill, or route through OpenRouter.

## Route facts

- Credential: `OPENROUTER_API_KEY`
- Raw endpoint: `POST https://openrouter.ai/api/alpha/decisions`
- Floating Jev alias: `~typesafe/jev-latest`
- Versioned model names, such as `typesafe/jev-1.13`, are preferable when reproducibility matters.
- Official Python package: `openrouter`

The direct TypeSafe SDK is the wrong adapter for this route. `TypeSafeClient` targets the TypeSafe protocol and appends `/v1/systemone` to its base URL. Changing its base URL does not turn that request into OpenRouter's `/api/alpha/decisions` protocol.

The OpenAI Python SDK is useful for OpenRouter's OpenAI-compatible generation endpoints, but it does not expose the typed Decisions interface. Use the official OpenRouter SDK or raw HTTP here.

## Raw HTTP

```python
import os

import requests


response = requests.post(
    "https://openrouter.ai/api/alpha/decisions",
    headers={
        "Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}",
        "Content-Type": "application/json",
    },
    json={
        "model": "~typesafe/jev-latest",
        "state": "The export button fails and we need the report before noon.",
        "questions": {
            "is_urgent": {
                "type": "noul",
                "instructions": "Does this message require urgent action?",
                "criteria": {
                    "true": "A stated deadline or immediate operational impact",
                    "false": "No time pressure or immediate impact",
                },
            },
            "department": {
                "type": "choice",
                "instructions": "Which team should handle this request?",
                "criteria": {
                    "technical": "Product defects, outages, or integrations",
                    "billing": "Charges, invoices, or refunds",
                    "sales": "Pricing, upgrades, or new accounts",
                },
            },
            "severity": {
                "type": "score",
                "instructions": "How severe is the reported problem?",
                "criteria": [
                    "Cosmetic; functionality still works",
                    "A feature is broken, but a workaround exists",
                    "Work is blocked and no workaround exists",
                ],
            },
        },
    },
    timeout=30,
)
response.raise_for_status()
answers = response.json()["answers"]
```

OpenRouter responses also identify the routed provider and may include cost in `usage`:

```json
{
  "id": "...",
  "model": "...",
  "provider": "TypeSafe",
  "answers": {},
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cost": 0.0
  }
}
```

Treat the example values as shape only; read the actual response.

## Official Python SDK

Install with the project's package manager:

```sh
uv add openrouter
```

The SDK uses generated component types for questions and answers:

```python
import os

from openrouter import OpenRouter, components


with OpenRouter(api_key=os.environ["OPENROUTER_API_KEY"]) as open_router:
    response = open_router.alpha.decisions.create(
        model="~typesafe/jev-latest",
        state="The export button fails and we need the report before noon.",
        questions={
            "is_urgent": components.DecisionsNoulQuestion(
                type="noul",
                instructions="Does this message require urgent action?",
                criteria=components.DecisionsNoulQuestionCriteria(
                    true="A stated deadline or immediate operational impact",
                    false="No time pressure or immediate impact",
                ),
            ),
            "department": components.DecisionsChoiceQuestion(
                type="choice",
                instructions="Which team should handle this request?",
                criteria={
                    "technical": "Product defects, outages, or integrations",
                    "billing": "Charges, invoices, or refunds",
                    "sales": "Pricing, upgrades, or new accounts",
                },
            ),
        },
        server_url="https://openrouter.ai",
        timeout_ms=30_000,
    )

urgent = response.answers["is_urgent"]
department = response.answers["department"]

if not isinstance(urgent, components.DecisionsNoulAnswer):
    raise TypeError("OpenRouter returned the wrong answer type for is_urgent")
if not isinstance(department, components.DecisionsChoiceAnswer):
    raise TypeError("OpenRouter returned the wrong answer type for department")

should_escalate = urgent.noul >= 0.8
team = department.choice
```

## Current alpha endpoint caveat

In `openrouter==1.1.159`, the generated client has a production server root of `https://openrouter.ai/api/v1` and a Decisions path of `/api/alpha/decisions`. Its default composition calls:

```text
https://openrouter.ai/api/v1/api/alpha/decisions
```

That URL returns 404. Passing `server_url="https://openrouter.ai"` makes the generated method call the working endpoint:

```text
https://openrouter.ai/api/alpha/decisions
```

This is an alpha route and generated SDK behavior can change. Before carrying the override into a newer SDK version, inspect the current generated `Decisions.create` path and make one minimal live request. Keep the override only while the SDK still composes the wrong URL.

Sources:

- https://github.com/OpenRouterTeam/python-sdk/blob/main/src/openrouter/decisions.py
- https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request
