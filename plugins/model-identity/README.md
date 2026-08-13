# Model Identity

Adds the resolved model slug and reasoning variant to every user message at dispatch time:

```xml
<model-slug>openai/gpt-5.6-sol</model-slug>
<model-effort>low</model-effort>
```

The tags are appended through the v2 session context hook, so they are sent to the model but never persisted or shown in the transcript. Every user message is stamped with the currently resolved model on every dispatch, which keeps the prompt prefix byte-identical across turns (prompt-cache safe) while the model is unchanged. When no variant is selected, the plugin writes `default`.

Unlike the v1 plugin, which persisted a synthetic part per message, a mid-session model switch restamps history with the new model on the next dispatch: history shows the current model rather than the model each message was originally sent with, at the cost of one prompt-cache miss.
