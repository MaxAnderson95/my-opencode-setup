---
name: system-one-models
description: >-
  ALWAYS load when Jev is mentioned, including questions, code, experiments, integrations, or debugging involving TypeSafe AI's Jev model. Also use for System One models, the Decisions API, noul/choice/score questions, calibrated decisions, typesafe-sdk, OpenRouter /api/alpha/decisions, or any model whose output modality is decisions. Covers the architecture, question design, parallel evaluation, result interpretation, and the route-specific choice between direct TypeSafe and OpenRouter raw APIs and Python SDKs.
---

# System One models

Treat a System One model as a typed decision function:

```text
state + named atomic questions -> typed answers with probabilities
```

Jev is TypeSafe AI's System One model. It evaluates questions about supplied state. It does not generate a prose response. Your code owns the workflow, thresholds, fallbacks, and side effects.

## How this differs from an LLM

| | System One model | Chat or completion LLM |
|---|---|---|
| Primary job | Make bounded decisions | Generate token sequences |
| Output | Typed values and distributions | Text, sometimes constrained to JSON |
| Composition | Ask atomic questions, combine answers in code | Put reasoning and orchestration in the prompt |
| Parallelism | Evaluates named questions independently against one state | Usually handles one conversational generation |
| Failure handling | Inspect probabilities and apply policy | Validate or parse generated output |

Typed output removes arbitrary text parsing. It does not make a decision infallible. Evaluate Jev on labeled examples from the target domain and set policy from those results.

## The three primitives

| Primitive | Ask when | Main result |
|---|---|---|
| `noul` | The answer is yes or no | `noul`, the probability of yes from 0 to 1 |
| `choice` | Exactly one label should win | `choice`, all option probabilities, and confidence |
| `score` | The answer lies on an ordered rubric | Fractional expected `score`, level probabilities, legend, and confidence |

Use the narrowest primitive that matches the decision. A Noul value near `0.5` means yes and no have similar probability; it does not mean a medium amount. Use Score for a spectrum.

For Score, describe concrete situations at each level. The model sees the descriptions, not an abstract meaning attached to the level number. Use the returned `score` for ranking and the highest-probability level when code needs one rubric label.

`confidence` describes how concentrated the returned distribution is. It is not a guarantee that the answer is correct.

## Build the decision

1. **Choose the route first.** Authentication, billing, model names, endpoint paths, and SDK choice depend on whether traffic goes directly to TypeSafe or through OpenRouter.
   - OpenRouter key, billing, or routing: read [`openrouter.md`](openrouter.md).
   - Direct TypeSafe account and key: read [`typesafe-direct.md`](typesafe-direct.md).
2. **Shape the state.** State can be a string, JSON object, or array. Include the evidence needed for every question in the request and omit unrelated material.
3. **Write atomic questions.** Each question should make one judgment that a knowledgeable person could make quickly. Split judgments that combine independent factors.
4. **Make criteria discriminating.** Describe what separates neighboring choices or score levels. Add `other` or `none` when the listed choices are not exhaustive.
5. **Ask together.** Put all questions about the same state in one request. Jev evaluates them independently and in parallel.
6. **Apply policy in code.** Threshold Nouls, inspect alternate Choice probabilities, normalize Scores before combining different scales, and send uncertain cases to an explicit fallback.
7. **Evaluate the complete policy.** Use labeled domain examples, record false positives and false negatives, and choose thresholds according to their actual cost.

Question IDs correlate requests and answers but are not instructions to the model. Put the full decision in `instructions`; do not rely on a descriptive ID to supply meaning.

## Parallel questions

Every question in a request sees the same state and is evaluated independently. Adding questions generally adds little latency, though it still adds tokens.

Questions cannot depend on each other's answers inside the model call. Ask speculative questions in the same request, then let code ignore answers that do not apply:

```text
department = returns
return_reason = wrong_size     <- use this
shipping_issue = delayed       <- ignore this
```

To evaluate several records in one call, use structured state with stable keys and one question per record. Name the target state key explicitly in each question's instructions because the question ID itself is not model input:

```json
{
  "state": {
    "ticket_01": "...",
    "ticket_02": "..."
  },
  "questions": {
    "ticket_01_is_urgent": {
      "type": "noul",
      "instructions": "Does the message under state key ticket_01 require urgent action?"
    },
    "ticket_02_is_urgent": {
      "type": "noul",
      "instructions": "Does the message under state key ticket_02 require urgent action?"
    }
  }
}
```

All questions still see all records. Keep keys unambiguous, reference exactly one key per question, and measure whether a large shared state changes accuracy. Use a dedicated batch interface if the provider adds one.

## Question-writing rules

- Describe situations rather than vague degrees: `Blocking issue; no workaround exists`, not `High severity`.
- Keep a Score to one dimension. Split `urgent, angry, and high-value` into separate questions.
- Make Choice descriptions distinguish neighbors and say what belongs elsewhere when confusion is likely.
- Use structured objects and examples only when plain strings fail on representative data.
- Phrase a Noul so a high value always has one clear operational meaning.
- Keep business weights and thresholds in code. Changing policy should not require rewriting prompts.

## Integration completion criteria

Before calling the integration complete, verify all of these:

- A live request reached the intended route: direct TypeSafe or OpenRouter.
- The selected SDK matches that route.
- Every answer is checked as its expected primitive before use.
- HTTP failures and timeouts surface as failures rather than default decisions.
- Thresholds and low-confidence behavior are explicit.
- Representative labeled examples exercise the complete decision policy.

## Primary references

- TypeSafe introduction: https://docs.typesafe.ai/introduction
- TypeSafe quick start: https://docs.typesafe.ai/introduction/quickstart
- TypeSafe primitives: https://docs.typesafe.ai/primitives
- OpenRouter Decisions reference: https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request
- OpenRouter Python SDK: https://openrouter.ai/docs/client-sdks/python/overview
