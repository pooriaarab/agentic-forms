---
name: agentic-forms
description: Build forms and collect answers into tables. Keywords: forms,surveys,responses,agents,mcp,cli,tables,collaboration.
---

# agentic-forms

Build forms and collect answers into tables.

## Use the SDK

```js
import { summarizeText, dispatchText } from "agentic-forms";

summarizeText("some text");
await dispatchText("some text", { dryRun: true });
```

## Use the CLI

```sh
agentic-forms summary --text "some text"
agentic-forms dispatch --text "some text" --dry-run
```

## Use the MCP server

Start the server with `agentic-forms mcp`. Call `summarize_text`
for stats, `dispatch_text` for routes, `get_cost_report` for costs.

## Rules

- Preview each route with dry run first.
- Report guard denials and adapter errors as failures.
- Read the cost report at the end.
