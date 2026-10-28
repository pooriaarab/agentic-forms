# agentic-forms

[![npm version](https://img.shields.io/npm/v/agentic-forms)](https://www.npmjs.com/package/agentic-forms)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-forms) · [Source](https://github.com/pooriaarab/agentic-forms) · [Support](https://github.com/pooriaarab/agentic-forms/issues)

Build forms and collect answers into tables.

> Status: scaffold. This repository holds the starter code only. It is not on npm
> yet, and none of the features below work yet.

## Planned features

- A form builder with common question types and logic.
- A public link to collect answers, with bot protection.
- Answers stored as rows you can export.
- Agent tools: make a form from a prompt and read the answers.
- Notices when a new answer comes in.
- Share by invite or link, with roles.

## Surfaces

One package gives you each way in:

- **Library and SDK**: `import { ... } from "agentic-forms"`.
- **CLI**: `npx agentic-forms --help`.
- **MCP server**: `npx agentic-forms mcp`, for Claude Code and other MCP clients.
- **HTTP API**: a Cloudflare Worker you deploy to your own account.
- **Web UI**: a small app served by the same Worker.

## Develop

```sh
npm ci
npm run build && npm run typecheck && npm test
```

## License

MIT.
