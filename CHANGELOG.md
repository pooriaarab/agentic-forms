# Changelog

This file lists what changed in each release. The versions follow semver. The API can still change before 1.0.

## 0.6.0 - 2026-10-29

Breaking changes. Read these before you upgrade from 0.5.0:

- Breaking for the CLI data file. The file store is now the one in `agentic-identity/file`. The data file has a new format. The store refuses a file from an earlier version with "not an agentic-identity store file" and does not change it. Version 0.5.0 is the last one that reads it. Nothing is migrated: forms, shares and responses stay in the old file. Export them with 0.5.0 before you upgrade.
- Breaking: the token of `FORMS_API_TOKEN` and of `createTokenAuth` must be 32 to 512 bytes of letters, digits, `_` and `-`. With another token the Worker fails every request, the public form pages too. The purge job still runs. Make a new token with `openssl rand -hex 32` before you deploy.
- Breaking: `/api/v1` checks the `Authorization` header before your `Auth` adapter runs, for every adapter you pass to `createApp`. A header that is not `Bearer` followed by 1 to 512 letters, digits, `_` and `-` answers 401. A JWT has dots, so the API refuses it. A write (POST, PUT, PATCH or DELETE) with no `Authorization` header answers 403 `bad origin`, even when your adapter accepts a cookie. An adapter that throws now answers 503 `auth unavailable`.
- Breaking: `FileStoreOptions` (`staleMs`, `waitMs`) is gone. `createFileStore(path, options)` keeps its call. Its options are `region` and `now`.

Other changes:

- Add `list` to the CLI. It prints every form in the data file as JSON. Add `list_forms` to the MCP server, and `ops.list()` to the SDK. The CLI and MCP server have no signed-in caller, so they list every form.
- The CSV header always has the questions of the published version, or of the draft before any publish. Then it has the questions of older versions that have responses. A form with no responses still exports its question columns. The column order can differ from 0.5.0.
- `createFileStore` runs a call again when another process won the race for the data file. A call that cannot take the lock within 5 seconds fails with "the store file is locked by another process". Version 0.5.0 waited 30 seconds.
- The store of agentic-identity takes over a lock older than 3 seconds and does not check that its owner is alive. A very slow write can lose a concurrent one.
- The HTTP API checks the caller with `agentic-identity/http`. The package depends on `agentic-identity` 0.6.x, not 0.4.x. If you use `agentic-identity` directly, upgrade it to 0.6.x too.

## 0.5.0 - 2026-10-29

No breaking changes. `agentic-design` moves from a dev dependency to a runtime dependency.

- Add `agentic-forms/ui`. `mount(element, { baseUrl, getToken })` renders the forms pages into an element and returns `update` and `unmount`. `agentic-forms/ui.css` holds its styles. `react` and `react-dom` 19 are optional peer dependencies, and `agentic-design` is now a dependency.
- `createClient` takes a function for `token`. It is called before each request.
- Add `wrangler.demo.jsonc` and a `deploy:demo` script for a live demo Worker. The npm package does not include them.
- Run the UI Playwright spec in CI. This does not change the package.
- Write the publish workflow's auth line with `printf`. This does not change the package.

## 0.4.0 - 2026-10-29

No breaking changes. The new options and fields are optional.

- Add a web UI for people. The Worker serves it at `/ui/`, and `GET /` goes there. A person signs in with an API token, builds a form, previews it, publishes it, and reads the responses. The UI calls the HTTP API. Each form action in it also exists in the SDK, CLI, MCP, or HTTP API. Listing forms exists only in the HTTP API and `agentic-forms/client`. The UI is built from this repo with `npm run build:ui`. The npm package does not include it.
- Add `PUT /api/v1/forms/<id>`, `ops.update`, `client.updateForm`, the `update` CLI command, and the `update_form` MCP tool. They replace the title, notice, retention, and sections, so you can edit, reorder, or remove questions. An absent `notice` or `retentionDays` is kept. Send `null` to remove one.
- Add `revision` to a form. It counts every save, including a draft edit. A form made before 0.4.0 reads as revision 0.
- `update` and `publish` take `expectedRevision`. A write that does not match the stored revision answers 409 `version_conflict` and changes nothing. `update` also takes `expectedVersion`. The CLI has `publish --expected-revision n`.
- Mark who made each question. `madeBy` is `human` or `agent`. The server sets it from the caller, and an unchanged question keeps its mark. The web UI shows an "Agent" mark. The CLI has a `--by human|agent` flag for local files.
- Export `formUpdateSchema` from the package.
- The fill page links `/ui/styles.css` for its look. A deployment without the UI assets gets a 404 for that stylesheet, and the page still works with its own fallback styles.

## 0.3.0 - 2026-10-29

- Add `agentic-forms/client`, a typed client for the Worker HTTP API. `createClient({ baseUrl, token, fetch? })` has one method per API route and the public submit.
- A refused call throws `ApiError` with the HTTP `status`, the API `code`, `issues`, and `retryAfter`.
- Every method takes `{ signal }` to cancel the call. The client never retries.
- The `token` is optional. Without it, only `health` and `submit` work, and other calls reject before they send.
- The client uses only web APIs, so it runs in Workers, Node 22, and browsers. A browser page must have the same origin as the Worker, because the Worker sends no CORS headers.
- A call rejects with a `TypeError` for an empty id, `.`, or `..`, so an id cannot change the route. `createClient` throws a `TypeError` for a `baseUrl` that is not absolute or that has a query, a fragment, or user info.

## 0.2.0 - 2026-10-29

Breaking changes. Read these before you upgrade from 0.1.0:

- Breaking: a share names a `kind`, `human` or `agent`. A person and an agent with the same id hold separate roles. `POST /api/v1/forms/<id>/shares` needs `kind`, and `DELETE /api/v1/forms/<id>/shares/<subject>` needs `?kind=human|agent`.
- Breaking: grants made before kinds are not honored. Run `POST /api/v1/migrate-grants` right after you deploy, and read `unresolved` in its answer.
- Breaking: `GET /api/v1/forms/<id>/audit` returns one page of `entries` and a `nextCursor`, not the whole list. It takes `limit` and `cursor`. Follow `nextCursor` to read all rows. A `limit` that is not a whole number from 1 to 200, or a cursor that is not valid, answers 400 `invalid_query`.
- Breaking: with no token and no stored credential, `/api/v1` answers 401, not 503.
- Breaking: the responses list answers 400 for a `limit` that is not a whole number from 1 to 1000, and for a cursor that is not valid.
- Breaking: a form id of the form `__name__` is refused at create, because the store keeps these ids.
- Breaking: the Worker no longer needs the `nodejs_compat` flag. Remove it from your config if you copied it.

Other changes:

- Move to `agentic-identity` 0.4.0.
- The Worker accepts credentials kept in the store, and they survive a restart. The shared `FORMS_API_TOKEN` is now optional and works as a bootstrap.
- Add `DELETE /api/v1/forms/<id>`. It erases the form, its answers, and its grants. Only an owner can run it.
- Answer a bad form id with 400 `invalid_id`, and a missing form with 404 `not_found`.
- Add `POST /api/v1/backfill-owners`, `backfillOwners`, `BackfillError`, and the `backfill-owners` CLI command to give forms made before roles an owner row.

## 0.1.0 - 2026-10-28

- First npm release: the form model, responses as table rows, the public fill page, the CLI, the MCP server, and the Worker API.
- Forms run on the shared `Store` port of `agentic-identity`, with owners, roles, sharing, and an audit log.
- A form with a notice needs consent before it stores an answer. Retention settings and a scheduled purge delete expired answers.
- The submit route has a rate limit that keeps its counters in the store.
- Ship the README, LICENSE, `llms.txt`, and `SKILL.md` in the package.
