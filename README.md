# agentic-forms

[![npm version](https://img.shields.io/npm/v/agentic-forms)](https://www.npmjs.com/package/agentic-forms)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-forms) · [Source](https://github.com/pooriaarab/agentic-forms) · [Support](https://github.com/pooriaarab/agentic-forms/issues)

Build forms and collect answers into tables.

> Status: first release, version 0.1.0. The library, CLI, MCP server, and Worker work. The API can still change before 1.0.

## Install

```sh
npm install agentic-forms
```

It needs Node 22 or newer. It depends on `agentic-identity` 0.2.x.

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
In code, pass any `Auth` port of `agentic-identity` to `createApp({ auth })`. The Worker uses one shared token, which acts as one principal that owns every form it makes.
Set the token as a secret: `wrangler secret put FORMS_API_TOKEN`. The token needs at least 32 bytes. With a shorter token the Worker refuses to serve. The token is a bootstrap. The Worker also accepts credentials kept in the store, and they survive a restart. Make one in code: write a principal with `store.put("principals", id, { id, kind: "human", scopes: ["*:admin"] })`, then call `issueCredential(store, { principalId: id, kind: "api_key" })` from agentic-identity. It returns the bearer token once. Only the bearer header counts, not a cookie. With no token set, the Worker logs a warning. With no token and no stored credential, every call answers 401.

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
- Agent tools: nine MCP tools and one CLI command each for make, extend, publish, submit, list, export, and purge.
- Access: every `/api/v1` route names the caller, and `can()` of `agentic-identity` decides it. The creator owns the form. Roles are owner, editor, and viewer. A viewer reads the form. An editor also edits, publishes, and reads answers. Only an owner shares, purges, and reads the audit log. A delegated agent keeps only the scopes it got. Each check is audited.
- Storage runs on the `Store` port of `agentic-identity`. The Worker uses D1, the
  CLI uses a locked JSON file, and tests use the memory adapter.

- A public fill page at `/f/<form id>`, served by the Worker. One HTML file, system
  fonts, no CDN, no third-party script. A strict content security policy.
- Built for WCAG 2.2 AA: labels, visible focus, 44px targets, a text error summary.
- A rate limit per client, kept in the store so every isolate shares it, and a bot-check hook that is off by default.
- GDPR: a privacy notice with a required consent box, and a retention period.
  The scheduled job and `purgeExpired` hard-delete responses past their date. Reads hide them before the job runs.

## Limits

- The Worker needs a D1 database. Create it in the EU: `wrangler d1 create agentic-forms --location weur`.
  Put its id in `wrangler.jsonc` and keep `FORMS_REGION` at `eu`. The region is your claim, and D1 refuses a query that another region served.
- The CLI and MCP server keep data in one JSON file. It is safe for several processes, and it is not a database. Each read loads the whole file, so keep it to small data sets. A file in an older format fails with a clear error.
- Local `wrangler dev` uses a D1 that reports no region, so the region check fails there. For local work only, set `FORMS_REGION=unknown` and `FORMS_UNSAFE_LOCAL_REGION=1`. Never set `FORMS_UNSAFE_LOCAL_REGION` in a deployed Worker.
- Import `createMemoryStore` and the `Store` types from `agentic-identity`. This package does not re-export them.
- The fill page needs JavaScript and does not show file questions.
- Forms made before roles have no owner. Give them one with one of these:
  - CLI: `agentic-forms backfill-owners --owner <id>`. It goes through every form.
  - HTTP: `POST /api/v1/backfill-owners` with `{"owner": "<id>"}`. It needs the all-forms admin scope.
  - Code: `backfillOwners(store, owner)`.

  Each HTTP or code call handles 25 forms, so it stays under the D1 call limit of one Worker request. Send the `nextCursor` back until it is absent. The HTTP `limit` is 25 at most. A page can still need more D1 calls than the Workers Free plan allows: use a smaller `limit` there. A form that already has a resource row is not touched, so a second run is safe. A form whose id is held by another resource type is listed under `conflicts`. A form whose id sharing cannot hold (for example `my.form`) is listed under `invalid` and not changed: recreate it with a valid id. The route does not write an audit row, so keep the call to trusted admins.
- The Worker deletes expired responses every 10 minutes (a Cron Trigger). The CLI does not schedule: run `purge-all` yourself. Each run reads a bounded number of pages per pass, so a big backlog clears over several runs. A run can need more D1 calls than the Workers Free plan allows. The ordered read has no index: a very large `responses` collection makes each page read slow.
- Set two Worker secrets: `wrangler secret put FORMS_RATE_SECRET` (32 bytes or more, it keys the hash of client addresses) and `FORMS_API_TOKEN`. Without the rate secret the Worker refuses requests. A client with no address header shares one counter. An IPv6 client counts by its /64. An attacker with many addresses can still make many counters: put the platform's rate limiting in front for that.
- The Worker tells callers apart only if you give `createApp` a real `Auth` adapter. With the shared token, every caller is one owner.
- Reading answers needs the editor role, so the audit log records it as a `write` check.
- The CLI and the MCP server act on a local file and skip roles. Whoever can open the file owns it.
- A form made before roles existed has no owner and is closed to the API.
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
