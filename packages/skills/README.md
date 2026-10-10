# @locus/skills

One folder per GHL API category. Each skill is a package of product knowledge plus the tests
that keep it honest:

```
<category>/
  SKILL.md         guidance: when to use what, quirks, which filters GHL applies natively
  manifest.ts      every operation, with the Version its spec requires
  fixtures/llm/    AIMock fixtures — what the "model" does in a test
  fixtures/ghl/    recorded GHL responses (preferred where the docs are wrong)
  evals/           prompt → expected skills and actions, run against a real model
```

Skills are generated from GHL's **live** docs export
(`https://marketplace.gohighlevel.com/docs/llms/v3/llms-full.txt`), then hand-deepened for
the categories that matter most (contacts, conversations, opportunities, calendars,
locations). The generator is not written yet.
