---
name: agentic-forms
description: Build forms and collect answers into tables. Keywords: forms,surveys,responses,agents,mcp,cli,tables,collaboration.
---

# agentic-forms

Build forms and collect answers into tables.

## Use the SDK

```js
import { validateAnswers, validateForm } from "agentic-forms";

validateForm(myForm); // [] when the logic is sound
validateAnswers(myForm, { q1: "yes" }); // { ok, issues, answers }
```

## Rules

- Report each issue as a failure.
- Do not point a condition at a later or deleted question.
