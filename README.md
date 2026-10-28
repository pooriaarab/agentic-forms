# agentic-forms

[![npm version](https://img.shields.io/npm/v/agentic-forms)](https://www.npmjs.com/package/agentic-forms)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-forms) · [Source](https://github.com/pooriaarab/agentic-forms) · [Support](https://github.com/pooriaarab/agentic-forms/issues)

Build forms and collect answers into tables.

> Status: early development. It is not on npm yet. The library, CLI, MCP server, and Worker work.

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

## Use it

```sh
npx agentic-forms new poll --title "Poll"
npx agentic-forms add-question poll --id color --type single_choice --label Color --choices red,blue --required
npx agentic-forms publish poll
npx agentic-forms responses poll
npx agentic-forms export poll > poll.csv
npx agentic-forms from-prompt --spec spec.json --publish   # an agent writes the JSON spec
npx agentic-forms mcp                                      # MCP tools on stdio
```

The CLI keeps data in `./agentic-forms.json` (`--data` or `AGENTIC_FORMS_DATA` change it).
`from-prompt` takes a JSON spec (`formSpecSchema`). No model runs inside this package.

The Worker serves `/f/<id>` (public) and `/api/v1/forms` (needs `Authorization: Bearer <token>`).
Set the token as a secret: `wrangler secret put FORMS_API_TOKEN`. The token needs at least 32 bytes. With a shorter token the Worker refuses to serve. With no token the API answers 503.

## Features

- Ten question types: short text, long text, number, email, single choice,
  multi choice, dropdown, date, rating, and file reference.
- Required flags, length, pattern, and range rules.
- Sections and conditions: show a question or a section when an earlier answer matches.
- Form checks: a logic cycle, logic that reads a later or deleted question,
  and repeated ids all fail `validateForm`.
- Answer checks: hidden questions never block a submit, and their answers are dropped.

- Responses: `submit` checks answers against the newest published version and
  stores one row per response, keyed by question id.
- Versions: `publish` freezes a version. Editing a published form starts a new
  draft. Old responses stay readable against their own version.
- `exportCsv` writes every response as CSV. It makes formula cells inert.
- Agent tools: eight MCP tools and one CLI command each for make, extend, publish, submit, list, export, and purge.
- A `Store` interface with the same shape as the agentic-identity port.

- A public fill page at `/f/<form id>`, served by the Worker. One HTML file, system
  fonts, no CDN, no third-party script. A strict content security policy.
- Built for WCAG 2.2 AA: labels, visible focus, 44px targets, a text error summary.
- A rate limit per client, and a bot-check hook that is off by default.
- GDPR: a privacy notice with a required consent box, and a retention period.
  `purgeExpired` deletes responses past their date.

## Limits

- The only store is in memory. Data is lost on exit.
- The fill page needs JavaScript and does not show file questions.
- The rate limit and the Worker store live in one isolate's memory.
- You must call `purgeExpired` yourself. Nothing schedules it yet.
- No sharing, roles, or sign-in yet. The API uses one shared token.
- The page test runs the page script in jsdom, not in a real browser.
- A pattern rule uses RE2 syntax and runs in linear time. Backreferences and lookaround are refused. A pattern has up to 256 characters, and a text with a pattern rule has up to 1000.
- `exportCsv` holds every response in memory. Use it for forms with up to a few thousand responses.

## Develop

```sh
npm ci
npm run ci:local
```

## License

MIT.
