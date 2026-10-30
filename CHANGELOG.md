# Changelog

This file lists what changed in each release. The versions follow semver. The API can still change before 1.0.

## 0.12.0 - 2026-10-30

### Added

- Publish a typed account registry contributor with support for every principal kind.
- Keep direct account calls as a compatibility path. Require identity 0.10 or later.

## 0.11.5 - 2026-10-30

### Changed

- Accept supported `agentic-design` and `agentic-identity` releases below 1.0.0.

## 0.11.4 - 2026-10-30

### Changed

- Accept `agentic-identity` 0.11.x alongside the earlier supported releases.

## 0.11.3 - 2026-10-30

### Changed

- Accept `agentic-design` 0.10.x alongside the earlier supported releases.

## 0.11.2 - 2026-10-30

### Changed

- Accept `agentic-identity` 0.9.x and 0.10.x, and `agentic-design` 0.8.x and 0.9.x, so current releases can install together.

## 0.11.1 - 2026-10-29

### Changed

- Move to `agentic-design` 0.8.x. The package depends on `^0.8.0` now, so it installs next to the other `agentic-*` packages without an `ERESOLVE` error. Two design changes reach the UI. The builder tabs use a roving tab index: Tab lands on the active tab, and the arrow keys move between tabs. The top bar no longer makes the page scroll sideways on a narrow screen. The screenshots in `docs/screenshots` are regenerated. No public API changes.

## 0.11.0 - 2026-10-29

### Added

- `agentic-forms/account` exports `formsAccount`, the package's side of account export and erase. `exportAccount(subject, { store })` returns plain JSON for forms, snapshots, answers, grants, and audit entries. `eraseAccount(subject, { store })` erases the forms the subject alone owns, and the subject's grants and audit entries, and returns counts. A repeat counts zero. The shape is provisional: a later `agentic-identity` release names it `AccountPackage`.

## 0.10.0 - 2026-10-29

### Added

- Invites and share links. The owner of a form can invite a person by email or an agent by handle, list the invites, make a share link, list the links, and revoke a link. SDK: `invite`, `listInvites`, `createLink`, `listLinks`, `revokeLink`. CLI: `invite`, `invites`, `link`, `links`, `unlink`. MCP tools: `create_invite`, `list_invites`, `create_link`, `list_links`, `revoke_link`. HTTP: `POST` and `GET` on `/api/v1/forms/:id/invites` and `/links`, and `DELETE /api/v1/forms/:id/links/:link`. An invite or a link gives editor or viewer, never owner. A list shows no email and no link token.

## 0.9.1 - 2026-10-29

### Changed

- Move to `agentic-identity` 0.9.x. The package depends on this range now. The code needed no change.

## 0.9.0 - 2026-10-29

### Changed

- The `/ui` app and the public form page at `/f/<id>` have a calmer look. Spacing is wider, borders are one pixel, and the form page uses a smaller type scale. The look follows Tiny Little Office (https://tinylittleoffice.com, MIT): quiet neutrals and soft borders. No code is copied.
- The builder has an "Add question" menu. Pick a type from the menu, and the dialog opens with that type chosen. The Type field stays in the dialog.
- Click a question name in the builder to rename it in place. Enter keeps the new name, and Escape keeps the old one.
- The reorder, edit, and remove buttons of a row show when the row has the pointer or the keyboard focus. On a touch screen, or a device that cannot hover, they always show.
- The empty section and the responses table use the quieter look, with a row highlight in the table.
- Move to `agentic-design` 0.5.x. Only token values changed, so no code that reads the semantic tokens needs an edit.

## 0.8.0 - 2026-10-29

Breaking changes. Read these before you upgrade from 0.7.0:

- BREAKING: design class prefix is now agd-. Design classes use `agd-`, and design custom properties use `--agd-*`, in the `/ui` app and on the public form page at `/f/<id>`. The old prefix is gone, with no alias. Ad blockers hide the old names, so a block rule could remove a button. A stylesheet or test that targets an old name must change. `agentic-design` is now 0.4.x, the release that ships the `agd-` names.

## 0.7.0 - 2026-10-29

Breaking change for code that composes the schemas. Read it before you upgrade. The new commands and tools are optional.

- Breaking: `formSpecSchema`, `formUpdateSchema`, and `questionSchema` are zod 4 schemas now, not zod 3. Code that builds on them with zod 3 (for example `.extend` or `.shape` from your own zod 3 import) must move to zod 4. The text of a validation error can also read differently.

### Added

- Sharing from the CLI and MCP. CLI commands `share`, `shares`, and `unshare`, and MCP tools `share_form`, `list_shares`, and `unshare_form`. They call the Worker, because roles live on the server: set `--url` (or `$AGENTIC_FORMS_URL`) and `$AGENTIC_FORMS_TOKEN`. A local file has no roles, so the MCP tools exist only with a Worker. `mcp` with a URL and no token starts without the sharing tools and warns on stderr. The Worker has no share links, so there is no command for them.
- `GET /api/v1/forms/:id/shares` lists who holds a role on a form (owner only), and the client has `listShares`.
- Export the `RemoteOptions` type. It is the second argument of `createMcpServer`.

### Changed

- Move to `agentic-identity` 0.7.x and `agentic-design` 0.3.x. The package depends on these ranges now. The code needed no change.
- The MCP SDK range starts at 1.23.0, the first version that accepts zod 4 schemas. An install that keeps an older lock file with SDK 1.22 or lower gets wrong tool schemas. Run `npm update @modelcontextprotocol/sdk` to move it.
- Raise `zod` to 4.6.6, from 3.x (see the breaking note above). Versions below 4.6.6 can run out of memory while they validate an oversized constrained collection (GHSA-mrhx-c7xc-m3w5). Move `agentic-design` to 0.3.3, which uses zod 4, so an install has one zod copy. An install that keeps an older lock file pins `agentic-design` 0.3.2, which uses zod 3. Run `npm update agentic-design` to move it.
- The publish workflow runs one publish at a time for each ref. A second run waits for the first one to finish. This does not change the package.

## 0.6.0 - 2026-10-29

Breaking changes. Read these before you upgrade from 0.5.0:

- Breaking: the CLI data file has a new format. The file store is now the one in `agentic-identity/file`. The store refuses a file from an earlier version with "not an agentic-identity store file" and does not change it. Version 0.5.0 is the last one that reads it. Nothing is migrated: forms, shares and responses stay in the old file. Export them with 0.5.0 before you upgrade.
- Breaking: the Worker no longer checks `FORMS_API_TOKEN`. It ignores the variable, logs a warning when it is set, and answers 401 to a caller that sends the old token. Only a credential kept in the store signs a caller in. Before you deploy, make the principal `deployment` and a credential for it, and share each old form with its real owner. Follow "Migrate off FORMS_API_TOKEN" in the README. Run `wrangler secret delete FORMS_API_TOKEN` after the deploy.
- Breaking: `createTokenAuth` is gone from the package exports. Pass an `Auth` adapter of `agentic-identity` to `createApp` instead.
- Breaking: `/api/v1` checks the `Authorization` header before your `Auth` adapter runs, for every adapter you pass to `createApp`. A header that is not `Bearer` followed by 1 to 512 letters, digits, `_` and `-` answers 401. A JWT has dots, so the API refuses it. A write (POST, PUT, PATCH or DELETE) with no `Authorization` header answers 403 `bad origin` when your adapter signs in the caller, for example from a cookie. An adapter that throws now answers 503 `auth unavailable`.
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
