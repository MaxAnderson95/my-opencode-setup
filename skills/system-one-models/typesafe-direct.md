# Jev through TypeSafe directly

Use this route when the application has a TypeSafe account and should authenticate and bill directly with TypeSafe.

## Route facts

- Credential: `TYPESAFE_API_KEY`
- Endpoint: `POST https://api.typesafe.ai/v1/systemone`
- Default model alias: `jev-latest`
- Official Python package: `typesafe-sdk`

## Raw HTTP

```python
import os

import requests


response = requests.post(
    "https://api.typesafe.ai/v1/systemone",
    headers={
        "Authorization": f"Bearer {os.environ['TYPESAFE_API_KEY']}",
        "Content-Type": "application/json",
    },
    json={
        "model": "jev-latest",
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
        },
    },
    timeout=30,
)
response.raise_for_status()
answers = response.json()["answers"]
```

## Official Python SDK

Install with the project's package manager:

```sh
uv add typesafe-sdk
```

`TypeSafeClient` reads `TYPESAFE_API_KEY` and defaults to `jev-latest`:

```python
from typesafe_sdk import Choice, Noul, Score, TypeSafeClient


with TypeSafeClient(timeout=30) as client:
    response = client.system_one(
        state="The export button fails and we need the report before noon.",
        questions={
            "is_urgent": Noul(
                instructions="Does this message require urgent action?",
                criteria={
                    "true": "A stated deadline or immediate operational impact",
                    "false": "No time pressure or immediate impact",
                },
            ),
            "department": Choice(
                instructions="Which team should handle this request?",
                criteria={
                    "technical": "Product defects, outages, or integrations",
                    "billing": "Charges, invoices, or refunds",
                    "sales": "Pricing, upgrades, or new accounts",
                },
            ),
            "severity": Score(
                instructions="How severe is the reported problem?",
                criteria=[
                    "Cosmetic; functionality still works",
                    "A feature is broken, but a workaround exists",
                    "Work is blocked and no workaround exists",
                ],
            ),
        },
    )

should_escalate = response.nouls["is_urgent"].noul >= 0.8
team = response.choices["department"].choice
severity = response.scores["severity"].score
```

The client also accepts explicit `api_key`, `model`, `base_url`, retry policy, headers, and an HTTP transport. `base_url` changes the TypeSafe API root; it does not change the `/v1/systemone` protocol and therefore does not make this client an OpenRouter Decisions client.

Sources:

- https://docs.typesafe.ai/sdk/python
- https://docs.typesafe.ai/sdk/python/api/clients/sync/client
- https://github.com/typesafe-ai/typesafe-sdk-python
