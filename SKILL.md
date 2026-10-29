---
name: agentic-forms
description: Build forms and collect answers into tables. Keywords: forms,surveys,responses,agents,mcp,cli,tables,collaboration.
---

# agentic-forms

Build forms and collect answers into tables.

## Use the SDK

```js
import { createFileStore, createOps } from "agentic-forms";

const ops = createOps(createFileStore("forms.json"));
await ops.create(spec, true); // spec matches formSpecSchema; true publishes
await ops.submit("poll", { color: "red" });
await ops.exportCsv("poll");
```

## Use the CLI

```sh
agentic-forms new poll --title "Poll"
agentic-forms from-prompt --spec spec.json --publish
agentic-forms responses poll
```

## Use the MCP server

Start it with `agentic-forms mcp`. The tools are `new_form`, `add_question`, `update_form`, `publish_form`, `get_form`, `submit_response`, `list_responses`, `export_csv`, `purge_expired`, and `purge_all`.

## Rules

- Report each error as a failure.
- Do not point a condition at a later or deleted question.
