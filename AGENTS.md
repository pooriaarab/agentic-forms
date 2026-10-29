# agentic-forms agent guide

Build forms and collect answers into tables.

## Mental model

A form holds sections. A section holds questions. A condition shows a
question or a section when an earlier answer matches. A save checks the
form logic. A submit checks the answers against the newest published version.

## The faces

- SDK: `import { createOps, createFileStore } from "agentic-forms"`.
- Remote SDK: `import { createClient } from "agentic-forms/client"` calls the Worker HTTP API. A refused call throws `ApiError` with `status` and `code`.
- CLI: `npx agentic-forms --help`.
- MCP: `npx agentic-forms mcp`, then call a tool below.
- HTTP: `/api/v1/forms` on the Worker, with a bearer token. Roles per form: owner, editor, viewer. Share with `POST /api/v1/forms/<id>/shares` (`{subject, kind, role}`, kind is `human` or `agent`: a person and an agent with the same id hold separate roles). Revoke with `DELETE /api/v1/forms/<id>/shares/<subject>?kind=human|agent`. `PUT /api/v1/forms/<id>` replaces the draft (title, sections; notice and retention stay unless you send them, null removes; `expectedRevision` refuses a stale write). The server marks each new or changed question `madeBy` `human` or `agent` from the caller. `DELETE /api/v1/forms/<id>` erases a form, its answers, and its grants. `POST /f/<id>` is the public submit.

## MCP tools

| Tool | Use it for |
| --- | --- |
| new_form | Make a form from a structured spec. Pass publish to open it. |
| add_question | Add one question. Editing a published form starts a new draft version. |
| update_form | Replace the title and sections. Edits, reorders, or removes questions. An absent notice or retentionDays is kept: send null to remove one. Pass expectedRevision (the form's `revision`, 0 if unset) so you never overwrite a newer change. Editing a published form starts a new draft version. |
| publish_form | Open the form to answers. |
| get_form | Read a form. |
| submit_response | Store one response. Pass consent when the form has a notice. |
| list_responses | Read responses as rows, oldest first. |
| export_csv | Export all responses as CSV. |
| purge_expired | Delete responses past the retention period. |
| purge_all | Delete expired responses of every form. |

## The loop

1. Write a JSON spec that matches `formSpecSchema`. Call `new_form`.
2. Read any error. Fix the spec. Never retry a refused spec unchanged.
3. Call `publish_form`.
4. Read answers with `list_responses` or `export_csv`.

## Rules

- A condition reads an earlier question. Never point it forward or at a deleted question.
- Report an error as a failure. Never present it as success.
- A form with a notice needs consent before it stores an answer. Never set consent for a person.
