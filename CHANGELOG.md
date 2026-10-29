# Changelog

This file lists what changed in each release. The versions follow semver. The API can still change before 1.0.

## 0.3.0

- Add `agentic-forms/client`, a typed client for the Worker HTTP API. `createClient({ baseUrl, token, fetch? })` has one method per API route and the public submit.
- A refused call throws `ApiError` with the HTTP `status`, the API `code`, `issues`, and `retryAfter`.
- Every method takes `{ signal }` to cancel the call. The client never retries.
- The client uses only web APIs, so it runs in browsers, Workers, and Node 22. It refuses an id of `.` or `..`, so an id cannot change the route.
- Test the client against the real Worker under `wrangler dev`.

## 0.2.0

- Move to `agentic-identity` 0.4.0.
- Use credentials kept in the store to sign in to the Worker. The shared `FORMS_API_TOKEN` is now optional and works as a bootstrap.
- Answer a bad form id with 400 `invalid_id`, and a missing form with 404 `not_found`.
- Add `POST /api/v1/backfill-owners` and `backfillOwners` to give forms made before roles an owner row.
- Revoking a share with `DELETE /api/v1/forms/<id>/shares/<subject>` needs `?kind=human|agent`.
- E2E tests close the connection on every request.

## 0.1.0

- First npm release: the form model, responses as table rows, the public fill page, the CLI, the MCP server, and the Worker API.
- Forms run on the shared `Store` port of `agentic-identity`, with owners, roles, sharing, and an audit log.
- A form with a notice needs consent before it stores an answer. Retention settings and a scheduled purge delete expired answers.
- The submit route has a rate limit that keeps its counters in the store.
- Ship the README, LICENSE, `llms.txt`, and `SKILL.md` in the package.
