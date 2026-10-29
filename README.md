# agentic-forms

[![npm version](https://img.shields.io/npm/v/agentic-forms)](https://www.npmjs.com/package/agentic-forms)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-forms) · [Source](https://github.com/pooriaarab/agentic-forms) · [Support](https://github.com/pooriaarab/agentic-forms/issues)

Build forms and collect answers into tables.

> Status: early release, version 0.8.0. The library, CLI, MCP server, and Worker work. The API can still change before 1.0.

## Install

```sh
npm install agentic-forms
```

It needs Node 22 or newer. It depends on `agentic-identity` 0.7.x and `agentic-design` 0.5.x.

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
npx agentic-forms update poll --spec edited.json            # edit, reorder, or remove questions (--by marks them: your own claim)
npx agentic-forms publish poll
npx agentic-forms responses poll
npx agentic-forms export poll > poll.csv
npx agentic-forms list                                      # every form in the data file, as JSON
npx agentic-forms from-prompt --spec spec.json --publish   # an agent writes the JSON spec
npx agentic-forms mcp                                      # MCP tools on stdio
```

To share a form, use a Worker. A local file has no roles, so these commands need `--url` (or `AGENTIC_FORMS_URL`) and the token of an owner in `AGENTIC_FORMS_TOKEN`:

```sh
export AGENTIC_FORMS_URL=https://forms.example.com AGENTIC_FORMS_TOKEN=<token>
npx agentic-forms share poll --subject bob --kind human --role editor   # give a role (owner only)
npx agentic-forms shares poll                                           # who holds a role (owner only)
npx agentic-forms unshare poll --subject bob --kind human               # take it away
```

Use an `https` URL: the token goes in a header. A role is `owner`, `editor`, or `viewer`. Only an owner may list shares. A refused call prints `error: <code>: <message>` and exits 1. With the same two variables, `agentic-forms mcp` also has the sharing tools below. Without them, these tools do not exist.

Every sharing call needs the owner role:

| Action | SDK (`createClient`) | CLI | MCP tool | HTTP (`/api/v1/forms/:id`) |
|---|---|---|---|---|
| Give a role | `share` | `share` | `share_form` | `POST /shares` |
| List roles | `listShares` | `shares` | `list_shares` | `GET /shares` |
| Take a role | `revokeShare` | `unshare` | `unshare_form` | `DELETE /shares/:subject?kind=` |
| Invite by email or handle | `invite` | `invite` | `create_invite` | `POST /invites` |
| List invites | `listInvites` | `invites` | `list_invites` | `GET /invites` |
| Make a share link | `createLink` | `link` | `create_link` | `POST /links` |
| List share links | `listLinks` | `links` | `list_links` | `GET /links` |
| Revoke a share link | `revokeLink` | `unlink --link <id>` | `revoke_link` | `DELETE /links/:link` |

An invite or a link that this API makes gives `editor` or `viewer`, never `owner`: only a share makes an owner. A list also shows a `commenter` invite or link that `agentic-identity` made. An invite names an `email` (a person) or a `handle` (an agent). `expiresInMs` (`--expires-in-ms`, at least 1000) sets how long it lives. `signedInOnly` (`--signed-in-only`) limits a link to signed-in people. A list shows no email and no link token: the token shows once, in the reply that makes the link. This Worker only makes and manages invites and links. To accept an invite or open a link, run `agentic-identity` on the same store.

The CLI keeps data in `./agentic-forms.json` (`--data` or `AGENTIC_FORMS_DATA` change it). The file uses the store format of agentic-identity. A file written by 0.5.0 or earlier is refused and not migrated.
`from-prompt` takes a JSON spec (`formSpecSchema`). No model runs inside this package.

The Worker serves `/f/<id>` (public) and `/api/v1/forms` (needs `Authorization: Bearer <token>`).
To run the Worker from your own Wrangler project, re-export its entry from `agentic-forms/worker`:
`export { default } from "agentic-forms/worker";`. The entry has a `fetch` handler and a `scheduled`
handler for the purge job. Your Wrangler config needs these:

- A D1 database bound as `DB`, created in the EU.
- The variable `FORMS_REGION`, set to `eu` for that database. Without it, every request fails. A region that does not match the database also fails.
- A Cron Trigger in `triggers.crons`. Without it, expired responses are never purged.
- The secret `FORMS_RATE_SECRET`, 32 bytes or more. Without it, the Worker refuses requests.

Make a credential in the store before you call `/api/v1` (see below). See `wrangler.jsonc` in this repo for an example. The web UI is not in
the package, so `/ui/` answers 404 in this setup.

In code, pass any `Auth` port of `agentic-identity` to `createApp({ auth })`. An `Authorization` header must be a bearer token of 1 to 512 letters, digits, `_` and `-`. Any other header answers 401 before the port runs. If your port signs in a caller from a cookie, a write with no `Authorization` header answers 403 `bad origin`.
The Worker accepts one kind of credential: a credential kept in the store, made with `issueCredential` from agentic-identity. It survives a restart. Write a principal with `store.put("principals", id, { id, kind: "human", scopes: ["*:admin"] })`, then call `issueCredential(store, { principalId: id, kind: "api_key" })`. It returns the bearer token once. Only the bearer header counts, not a cookie. A call with no credential or a wrong one answers 401. A valid credential without the right scope or role answers 403. If the store cannot be read, the call answers 503.

### Migrate off FORMS_API_TOKEN

Before this change, the Worker also accepted one shared token in `FORMS_API_TOKEN`. That path is gone. The Worker ignores the variable and logs a warning when it is set. Callers that sent the shared token now get 401. To migrate:

1. Do these steps before you deploy the new Worker, or the deployment is locked out. Make the principal `deployment` with kind `agent` and scope `*:admin` in the store, and issue a credential for it, as above. The shared token signed callers in as this principal, and it owns every form the token made. The id and the kind both matter.
2. With that credential, share each old form with its real owner: `POST /api/v1/forms/<id>/shares` with role `owner`. `backfillOwners` does not help here: it skips a form that already has an owner.
3. Give each other caller its own credential.
4. Run `wrangler secret delete FORMS_API_TOKEN`.

## Live demo

A demo Worker runs at <https://agentic-forms-demo.hello-fd1.workers.dev>. Check it with `/health`. The web UI is at `/ui/`. The API needs a bearer token, so a call without one answers 401. The demo keeps its data in a D1 database in the EU. It is for tests: do not put real answers in it.

Deploy your own copy of the demo from a checkout. You do not need a CI secret.

```sh
npx wrangler d1 create agentic-forms-demo --location weur   # once: put the id in wrangler.demo.jsonc
npx wrangler secret put FORMS_RATE_SECRET -c wrangler.demo.jsonc   # 32 bytes or more
npm ci
npm run deploy:demo
```

`npm run deploy:demo` builds the UI and runs `wrangler deploy` with `wrangler.demo.jsonc`. It sets `WRANGLER_SEND_METRICS=false`. Log in with `wrangler login` or set `CLOUDFLARE_API_TOKEN` in your shell first. Never commit the token.

## SDK

`agentic-forms/client` calls the Worker over HTTP. It uses only `fetch`, so it runs in browsers, Workers, and Node 22.

```ts
import { createClient, ApiError } from "agentic-forms/client";

const forms = createClient({ baseUrl: "https://forms.example.com", token: process.env.FORMS_TOKEN! });
await forms.createForm({ id: "poll", title: "Poll", publish: true, sections: [{ id: "s", title: "S", questions: [{ id: "color", type: "single_choice", label: "Color", choices: ["red", "blue"] }] }] });
await forms.submit("poll", { color: "red" });
const { items } = await forms.listResponses("poll");
try {
  await forms.getForm("missing");
} catch (error) {
  if (error instanceof ApiError) console.log(error.status, error.code); // 404 "not_found"
}
```

There is one method per API route: `health`, `listForms`, `createForm`, `getForm`, `updateForm`, `addQuestion`, `publishForm`, `listResponses`, `exportCsv`, `purge`, `eraseForm`, `share`, `listShares`, `revokeShare`, `invite`, `listInvites`, `createLink`, `listLinks`, `revokeLink`, `listAudit`, `purgeAll`, `migrateGrants`, `backfillOwners`, and the public `submit` (it sends no token). `GET /f/<id>` is a page for people, so it has no method.

- A refused call throws `ApiError` with `status` (HTTP status), `code` (the API `error` field), `message`, `retryAfter` (seconds, on a 429), and `issues` when the API lists faults.
- Every method takes `{ signal }` last, to cancel the call with an `AbortSignal`. A cancel rejects with the reason of the signal (an `AbortError` by default).
- The client never retries. A retry of `createForm`, `submit`, or `purge` could repeat the write, so the caller decides.
- `token` is optional. Without it, only `health` and `submit` work, so a browser page can submit with no secret. Any other call rejects with a `TypeError` before it sends.
- In a browser, the page must have the same origin as the Worker. The Worker sends no CORS headers.
- An id of `.` or `..` rejects with a `TypeError`, so it can never change the route.
- `baseUrl` must be an absolute URL with no query, fragment, or user info. `createClient` throws a `TypeError` at once if it is not.
- A 2xx reply that is not JSON rejects with `ApiError` (`code` is `bad_response`).
- Pass `fetch` to `createClient` to use a proxy or a test double. For a service binding, pass `(input, init) => env.FORMS.fetch(input, init)`.

### Use the repo and the MCP server in your code

The package root exports `createFormRepo` and `createMcpServer`. Use them when your app keeps forms in its own `Store` (the port of `agentic-identity`). The app imports the store and the memory adapter from `agentic-identity`.

```ts
import { createMemoryStore } from "agentic-identity";
import { createFormRepo, createMcpServer } from "agentic-forms";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const store = createMemoryStore();
const forms = createFormRepo(store); // read with forms.getPublished(id)
await createMcpServer(store).connect(new StdioServerTransport()); // the eleven tools of `agentic-forms mcp` without a Worker URL
```

A stdio server writes only MCP messages to stdout, so do not log there.

`createFormRepo(store)` returns:

- `get(id)` reads the head (the latest version, draft or published). It returns `null` when the form is missing. `getVersion(id, version)` reads one frozen version. It returns `null` when that version was never published, or when `erase` removed it.
- `getPublished(id)` reads the version that takes answers now. It returns `null` when the form is missing or no version is published yet.
- `list()` reads every head, in order of id, and follows every page.
- `save(form, { expectedVersion?, expectedRevision? })` stores a draft. It throws `FormError` on unsound logic. `expectedRevision` makes the save a compare-and-set on every change: it throws `VersionConflictError` when any save or publish came after the caller's read, or when the form was erased. `expectedVersion` compares only the version number, and the version changes only when a save follows a publish. So it does not catch a publish, or a second save to the same draft. Use `expectedRevision` for those.
- `publish(id, { expectedRevision? })` freezes the head as a new version. It throws `FormError` when the form has faults for publishing, `VersionConflictError` when the head changed since `expectedRevision`, and `SnapshotExistsError` rather than replace a frozen version. It throws a plain `Error` when the form does not exist or is already published.
- `erase(id)` deletes the head first, so no new answer lands, then every frozen version. It is safe to run again.

`createMcpServer(store, remote?)` returns an `McpServer`. Connect it to any transport of `@modelcontextprotocol/sdk`. Without `store`, it uses a memory store that is lost when the process exits. Pass `remote` as `{ url, token }` to add the three sharing tools, as the CLI does with `AGENTIC_FORMS_URL` and `AGENTIC_FORMS_TOKEN`. The MCP tools read and write the store as it is. They do not check a caller's role, so give an agent only the store it may change.

## Account export and erase

A host that runs account export and erase calls `formsAccount` from `agentic-forms/account`, so it never reads the storage layout. The subject is `{ id, kind }`, with `kind` set to `human` or `agent`: a person and an agent with one id are two subjects.

```ts
import { formsAccount } from "agentic-forms/account";

const data = await formsAccount.exportAccount({ id: "ana", kind: "human" }, { store });
const counts = await formsAccount.eraseAccount({ id: "ana", kind: "human" }, { store });
```

- The export has plain JSON in `forms`, `form_versions`, `responses` (the forms the subject owns, with their answers), `grants` (every role the subject holds on a form), and `audit` (the entries rooted in the subject).
- The erase removes each form that the subject alone owns, with its snapshots, answers, and grants. A form with another owner stays, and only the subject's grant goes. The grants of the subject on other forms go too. Last, the audit entries rooted in the subject go. It returns counts by the same names.
- A repeat of the erase counts zero. If it stops, the error names the form id, and a repeat goes on from there.
- Answers hold no respondent id, so they are exported only with their form. Invites and links keep the id of their maker with no kind, so they leave only with their form.
- The shape is provisional: a later `agentic-identity` release names it `AccountPackage`. Stop writes before you run the erase.

## UI

The Worker serves a small web UI at `/ui/`. It uses the [`agentic-design`](https://www.npmjs.com/package/agentic-design) package for tokens, controls, dialogs, and the app shell. It calls the API through `agentic-forms/client`.

What you can do in it:

- Sign in with an API token. The token stays in the browser tab only (`sessionStorage`). Signing out removes it.
- List forms, and make a new one.
- Build a form: add, edit, reorder, and remove questions of every type, with choices, limits, and a "show only when" condition. Save sends the whole draft. A save that follows a change made elsewhere is refused, and the page asks you to reload.
- Preview the form. The preview shows and hides questions by their conditions and sends nothing.
- Publish, and copy the public link `/f/<id>`. The link opens the public fill page, which uses the same tokens, in light and dark.
- Read the responses in a table (100 per page) and export them as CSV.
- See which questions an agent made or changed. The server sets that mark from the caller. Only a person (a principal of kind `human`) makes human-marked questions. Every other kind, such as an agent, a delegated agent, or a personal token used by an agent, is marked as an agent. A credential of an agent principal shows the agent mark on every question it makes.

Run it on your machine:

```sh
npm ci
npm run build:ui
WRANGLER_SEND_METRICS=false npx wrangler dev --local \
  --var FORMS_REGION:unknown --var FORMS_UNSAFE_LOCAL_REGION:1 \
  --var FORMS_RATE_SECRET:$(openssl rand -hex 32)
```

Make a local credential once, with a token you keep (the store holds only its SHA-256):

```sh
TOKEN=$(openssl rand -hex 32); HASH=$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)
WRANGLER_SEND_METRICS=false npx wrangler d1 execute DB --local --command "CREATE TABLE IF NOT EXISTS store_docs (collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (collection, id)) WITHOUT ROWID; INSERT OR REPLACE INTO store_docs (collection, id, body, version) VALUES ('principals', 'me', '{\"id\":\"me\",\"kind\":\"human\",\"scopes\":[\"*:admin\"]}', 1), ('credentials', '$HASH', '{\"principalId\":\"me\",\"kind\":\"session\"}', 1)"
echo "$TOKEN"
```

Open `http://127.0.0.1:8787/ui/` and sign in with that token. Run the browser tests with `npm run test:ui`: Playwright starts `wrangler dev`, builds a form, fills it by its link, reads the response, reloads, and runs an axe WCAG 2.2 AA scan on every view in light and dark. Screenshots of each view in both schemes are in `docs/screenshots/`. They are rewritten on each run.

The Worker UI bundle is not in the npm package. The `agentic-forms/ui` export is. Deploy the Worker UI from a checkout with `npm run build:ui && wrangler deploy`. A file upload question shows in the builder, but the form page cannot take files yet. The UI makes no request to another site, and it loads its fonts from the Worker.

### Mount the UI in your app

`agentic-forms/ui` renders the same pages inside your own page. It needs no framework in your app. You give it an
element, the Worker base URL, and a function that returns the token. `mount` returns a handle.

```ts
import { mount } from "agentic-forms/ui";
import "agentic-design/styles.css";
import "agentic-forms/ui.css";

const forms = mount(document.getElementById("forms")!, {
  baseUrl: "https://forms.example.com",
  getToken: () => session.token(), // called before each request, so a host can refresh it
});

forms.update({ baseUrl: "https://other.example.com", getToken }); // point it at another Worker
forms.unmount(); // remove the UI
```

`getToken` may return a promise. An empty token, or a refused call, shows as an error in the UI. The person presses Try again after the token is valid. A missing
`getToken` or a bad `baseUrl` throws a `TypeError` and renders nothing. The server still checks every call against
the token. The public link of a form points at `baseUrl`. The pages follow the address hash
(`#/forms/<id>`), so they own that hash while mounted. `react` and `react-dom` (version 19) are peer dependencies.
`createClient` from `agentic-forms/client` also accepts a function for `token`.

## Features

- Ten question types: short text, long text, number, email, single choice,
  multi choice, dropdown, date, rating, and file.
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
- Agent tools: eleven MCP tools, and eight more with a Worker (`share_form`, `list_shares`, `unshare_form`, `create_invite`, `list_invites`, `create_link`, `list_links`, `revoke_link`). The CLI has these commands: `new`, `add-question`, `update`, `publish`, `submit`, `list`, `show`, `responses`, `export`, `purge`, `purge-all`, `from-prompt`, `backfill-owners`, and `mcp`. With a Worker, it also has `share`, `shares`, `unshare`, `invite`, `invites`, `link`, `links`, and `unlink`.
- Access: every `/api/v1` route names the caller, and `can()` of `agentic-identity` decides it. The creator owns the form. Roles are owner, editor, and viewer. A viewer reads the form. An editor also edits, publishes, and reads answers. Only an owner shares, purges, deletes the form, and reads the audit log. A share names a kind, `human` or `agent`, because a person and an agent with the same id hold separate roles. Revoking with `DELETE .../shares/<subject>` needs `?kind=` too. Grants made before kinds are not honored until an admin runs `POST /api/v1/migrate-grants`: run it right after you deploy, and read `unresolved` in its answer. `backfill-owners` always makes the owner a person. A delegated agent keeps only the scopes it got. Each check is audited.
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
- The CLI and MCP server keep data in one JSON file. It is safe for several processes, except that a write slower than 3 seconds can lose a concurrent one. It is not a database. Each read loads the whole file, so keep it to small data sets. A file in an older format fails with a clear error.
- Local `wrangler dev` uses a D1 that reports no region, so the region check fails there. For local work only, set `FORMS_REGION=unknown` and `FORMS_UNSAFE_LOCAL_REGION=1`. Never set `FORMS_UNSAFE_LOCAL_REGION` in a deployed Worker.
- Import `createMemoryStore` and the `Store` types from `agentic-identity`. This package does not re-export them.
- The fill page needs JavaScript and does not show file questions.
- Forms with no owner row (made before roles, or made through the SDK, CLI or MCP) are closed to the API. Give them one with one of these:
  - CLI: `agentic-forms backfill-owners --owner <id>`. It goes through every form.
  - HTTP: `POST /api/v1/backfill-owners` with `{"owner": "<id>"}`. It needs the all-forms admin scope.
  - Code: `backfillOwners(store, owner)`.

  Each HTTP or code call handles at most `limit` forms (25 if you do not give it), so it stays under the D1 call limit of one Worker request. Send the `nextCursor` back until it is absent. The `limit` is 25 at most. A page can still need more D1 calls than the Workers Free plan allows: use a smaller `limit` there. A form that already has a resource row is not touched, so a second run is safe. The owner is not checked against the people you know: a mistyped owner gets every old form, and a second run with the right owner changes nothing. Check the owner before the first run. A form whose id is held by another resource type is listed under `conflicts`. A form whose id sharing cannot hold (for example `my.form`) is listed under `invalid` and not changed: recreate it with a valid id. The route does not write an audit row, so keep the call to trusted admins.
- The Worker deletes expired responses every 10 minutes (a Cron Trigger). The CLI does not schedule: run `purge-all` yourself. Each run reads a bounded number of pages per pass, so a big backlog clears over several runs. A run can need more D1 calls than the Workers Free plan allows. The ordered read has no index: a very large `responses` collection makes each page read slow.
- Set the Worker secret `wrangler secret put FORMS_RATE_SECRET` (32 bytes or more, it keys the hash of client addresses), and make a credential in the store. Without the rate secret the Worker refuses requests. A client with no address header shares one counter. An IPv6 client counts by its /64. An attacker with many addresses can still make many counters: put the platform's rate limiting in front for that.
- The Worker tells callers apart by the credential kept in the store. One credential for many callers makes them one owner.
- Reading answers needs the editor role, so the audit log records it as a `write` check.
- The CLI and the MCP server act on a local file and skip roles. Whoever can open the file owns it.
- A form made before roles existed has no owner and is closed to the API.
- The page test runs the page script in jsdom, not in a real browser.
- A pattern rule uses RE2 syntax and runs in linear time. Backreferences and lookaround are refused. A pattern has up to 256 characters, and a text with a pattern rule has up to 1000.
- `exportCsv` holds every response in memory. Use it for forms with up to a few thousand responses.

## Run locally

```sh
git clone https://github.com/pooriaarab/agentic-forms
cd agentic-forms
npm install && npm run dev
```

You can also use `bun install && bun run dev`. The `dev` script calls npm, so npm must be installed. The scripts need macOS, Linux, or WSL. The `dev` script builds the UI. The Worker needs a `FORMS_RATE_SECRET` of 32 bytes or more. If `.dev.vars` is missing, the script writes it with a random secret. Git ignores the file. If you have a `.dev.vars` already, add the secret to it (see `.dev.vars.example`). Then the script starts `wrangler dev` on <http://localhost:8792>. Wrangler keeps a local D1 database. The `dev` script turns off Wrangler telemetry. Set `WRANGLER_SEND_METRICS=false` when you run other wrangler commands.

```sh
curl -i http://localhost:8792/health   # 200
```

`npm run dev:smoke` runs the same check by itself. It starts the dev server. It waits for `/health` to answer 200. It stops the server. CI runs it as the "dev smoke" step. To use another port, change `8792` in the `dev` and `dev:smoke` scripts.

## Develop

```sh
npm ci
npm run ci:local
```

## License

MIT.
