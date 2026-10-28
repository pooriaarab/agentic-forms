# agentic-forms agent guide

Build forms and collect answers into tables.

## Mental model

A form holds sections. A section holds questions. A condition shows a
question or a section when an earlier answer matches. `validateForm` checks the
form logic. `validateAnswers` checks the answers against the form.

## What works now

- SDK only: `import { validateForm, validateAnswers } from "agentic-forms"`.
- The CLI, MCP server, and HTTP API are not built yet.

## Rules

- Run `validateForm` before you publish a form. Stop on any issue.
- A condition reads an earlier question. Never point it forward or at a deleted question.
- Report an issue list as a failure. Never present it as success.
