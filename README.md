# agentic-forms

[![npm version](https://img.shields.io/npm/v/agentic-forms)](https://www.npmjs.com/package/agentic-forms)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-forms) · [Source](https://github.com/pooriaarab/agentic-forms) · [Support](https://github.com/pooriaarab/agentic-forms/issues)

Build forms and collect answers into tables.

> Status: early development. It is not on npm yet. Only the library below works.

## Install

```sh
npm install agentic-forms
```

## Quick start

```ts
import { validateAnswers, validateForm, type Form } from "agentic-forms";

const form: Form = {
  id: "survey", title: "Survey", version: 1, status: "draft",
  sections: [{ id: "main", title: "Main", questions: [
    { id: "role", type: "single_choice", label: "Role", required: true, choices: ["dev", "other"] },
    { id: "stack", type: "short_text", label: "Stack", required: true,
      showIf: { question: "role", op: "equals", value: "dev" } },
  ] }],
};

validateForm(form); // []
validateAnswers(form, { role: "other" }).ok; // true: "stack" stays hidden
validateAnswers(form, { role: "dev" }).issues; // one "required" issue for "stack"
```

## Features

- Ten question types: short text, long text, number, email, single choice,
  multi choice, dropdown, date, rating, and file reference.
- Required flags, length, pattern, and range rules.
- Sections and conditions: show a question or a section when an earlier answer matches.
- Form checks: a logic cycle, logic that reads a later or deleted question,
  and repeated ids all fail `validateForm`.
- Answer checks: hidden questions never block a submit, and their answers are dropped.

## Limits

- No store, responses, CLI, MCP server, HTTP API, or fill page yet.
- A pattern rule uses RE2 syntax and runs in linear time. Backreferences and lookaround are refused. A pattern has up to 256 characters, and a text with a pattern rule has up to 1000.

## Develop

```sh
npm ci
npm run ci:local
```

## License

MIT.
