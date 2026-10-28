# Authoring agents

Agent packages select one of the user's existing Preferences model slots. They never name a provider or concrete model.

```json
{
  "apiVersion": "sulla/v3",
  "kind": "Agent",
  "manifestVersion": 1,
  "metadata": { "slug": "researcher", "title": "Researcher", "description": "Researches a topic", "version": "1.0.0" },
  "spec": { "modelSlot": "secondary", "prompt": "Research the brief.", "tools": [], "skills": [], "config": {}, "promptFiles": {} }
}
```

`modelSlot` is one of `primary`, `secondary`, or `subconscious`. At runtime Sulla reads that slot's provider and model from Preferences. A model explicitly selected for the current chat remains the highest-priority override.

Older packages containing `model` and `provider` still import. Sulla migrates their concrete model to the closest existing slot, but new and exported packages write only `modelSlot`.
