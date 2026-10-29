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

## Use the remote client

```js
import { createClient, ApiError } from "agentic-forms/client";

const forms = createClient({ baseUrl: "https://forms.example.com", token });
await forms.submit("poll", { color: "red" }); // no token needed for submit
const { items } = await forms.listResponses("poll");
```

A refused call throws `ApiError` with `status` and `code`. Pass `{ signal }` to cancel. The client never retries. A browser page needs the same origin as the Worker.

## Use the CLI

```sh
agentic-forms new poll --title "Poll"
agentic-forms from-prompt --spec spec.json --publish
agentic-forms responses poll
```

## Use the MCP server

Start it with `agentic-forms mcp`. The tools are `new_form`, `add_question`, `update_form`, `publish_form`, `list_forms`, `get_form`, `submit_response`, `list_responses`, `export_csv`, `purge_expired`, and `purge_all`.

## The web UI

People use the web UI at `/ui/` on the Worker. An agent never needs it: every action except listing forms is a tool, a command, or an API call. Listing forms is an API call. Questions an agent makes or changes show an "Agent" mark in the UI.

## Rules

- Report each error as a failure.
- Do not point a condition at a later or deleted question.
