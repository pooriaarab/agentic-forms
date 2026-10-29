#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ZodError } from "zod";
import { BackfillError } from "./core/backfill.js";
import { FormError, VersionConflictError } from "./core/repo.js";
import { createFileStore } from "./core/file-store.js";
import type { Answers } from "./core/form.js";
import { SubmitError } from "./core/responses.js";
import { OpsError, createOps } from "./ops.js";
import { VERSION } from "./version.js";

const HELP = `agentic-forms ${VERSION}
Build forms and collect answers into tables.

Usage: agentic-forms <command> [flags]

Commands:
  new <id> --title <t> [--notice <t>] [--retention-days <n>]   Make a draft form.
  add-question <id> --id <q> --type <type> --label <t>         Add a question.
      [--required] [--choices a,b] [--show-if q:op[:value]] [--section <s>]
      [--min n] [--max n] [--min-length n] [--max-length n] [--pattern re]
  from-prompt --spec <file|-> [--publish]                      Make a form from a JSON spec.
  update <id> --spec <file|->                                  Replace title, notice, and sections from JSON.
  publish <id> [--expected-revision n]                         Open the form to answers.
  list                                                         Print every form in the data file as JSON.
  show <id>                                                    Print the form as JSON.
  submit <id> --answers <json> [--consent]                     Store one response.
  responses <id> [--limit n] [--cursor c]                      Print responses as JSON.
  export <id>                                                  Print responses as CSV.
  purge <id>                                                   Delete responses past retention.
  purge-all                                                    Delete expired responses of every form.
  backfill-owners --owner <id>                                 Give forms made before roles an owner. Safe to run again.
  mcp                                                          Start the MCP server on stdio.

Flags:
  --by <human|agent>   Mark the questions this command makes or changes. Default: no mark. A local file has no signed-in caller, so this is your own claim.
  --data <file>   Data file. Default: $AGENTIC_FORMS_DATA or ./agentic-forms.json.
  --help, -h      Print this help.
  --version, -V   Print the version.`;

class UsageError extends Error {}

const BOOLEAN_FLAGS = new Set(["required", "consent", "publish", "help"]);

function parse(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h") flags.help = true;
    else if (arg === "-V") flags.version = true;
    else if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (BOOLEAN_FLAGS.has(name) || name === "version") flags[name] = true;
      else if (i + 1 < argv.length) flags[name] = argv[++i];
      else throw new UsageError(`--${name} needs a value`);
    } else positional.push(arg);
  }
  return { positional, flags };
}

const num = (flags: Record<string, string | true>, name: string): number | undefined => {
  if (flags[name] === undefined) return undefined;
  const value = Number(flags[name]);
  if (!Number.isFinite(value)) throw new UsageError(`--${name} needs a number`);
  return value;
};

function showIf(text: string) {
  const [question, op, ...rest] = text.split(":");
  const value = rest.join(":");
  return { question, op, ...(rest.length > 0 ? { value: op === "gt" || op === "lt" ? Number(value) : value } : {}) };
}

export async function runCli(argv: string[], out: (text: string) => void = console.log, err: (text: string) => void = console.error): Promise<number> {
  try {
    const { positional, flags } = parse(argv);
    const [command, id] = positional;
    if (flags.version) return out(VERSION), 0;
    if (command === undefined || flags.help) return out(HELP), 0;
    if (command === "mcp") {
      const { startMcp } = await import("./mcp.js");
      await startMcp(createFileStore(dataPath(flags)));
      return 0;
    }
    const by = flags.by === undefined ? undefined : flags.by === "human" || flags.by === "agent" ? flags.by : (() => { throw new UsageError("--by is human or agent"); })();
    const ops = createOps(createFileStore(dataPath(flags)));
    const need = () => {
      if (id === undefined) throw new UsageError(`${command} needs a form id`);
      return id;
    };
    const str = (name: string) => {
      const value = flags[name];
      if (typeof value !== "string") throw new UsageError(`${command} needs --${name}`);
      return value;
    };
    switch (command) {
      case "new":
        out(JSON.stringify(await ops.create({ id: need(), title: str("title"), notice: flags.notice, retentionDays: num(flags, "retention-days"), sections: [{ id: "main", title: str("title"), questions: [] }] }, false, by)));
        return 0;
      case "add-question": {
        const choices = typeof flags.choices === "string" ? flags.choices.split(",") : undefined;
        const rules = { minLength: num(flags, "min-length"), maxLength: num(flags, "max-length"), min: num(flags, "min"), max: num(flags, "max"), pattern: flags.pattern };
        const question = {
          id: str("id"),
          type: str("type"),
          label: str("label"),
          required: flags.required === true,
          choices,
          rules: Object.values(rules).some((v) => v !== undefined) ? rules : undefined,
          showIf: typeof flags["show-if"] === "string" ? showIf(flags["show-if"]) : undefined,
        };
        out(JSON.stringify(await ops.addQuestion(need(), question, typeof flags.section === "string" ? flags.section : undefined, by)));
        return 0;
      }
      case "from-prompt": {
        const spec = str("spec");
        out(JSON.stringify(await ops.create(JSON.parse(readFileSync(spec === "-" ? 0 : spec, "utf8")), flags.publish === true, by)));
        return 0;
      }
      case "update": {
        const spec = str("spec");
        out(JSON.stringify(await ops.update(need(), JSON.parse(readFileSync(spec === "-" ? 0 : spec, "utf8")), by)));
        return 0;
      }
      case "publish":
        out(JSON.stringify(await ops.publish(need(), { expectedRevision: num(flags, "expected-revision") })));
        return 0;
      case "list":
        out(JSON.stringify(await ops.list()));
        return 0;
      case "show":
        out(JSON.stringify(await ops.get(need())));
        return 0;
      case "submit": {
        const answers = JSON.parse(str("answers")) as Answers;
        out(JSON.stringify(await ops.submit(need(), answers, flags.consent === true)));
        return 0;
      }
      case "responses":
        out(JSON.stringify(await ops.listResponses(need(), { limit: num(flags, "limit"), cursor: typeof flags.cursor === "string" ? flags.cursor : undefined })));
        return 0;
      case "export":
        out((await ops.exportCsv(need())).trimEnd());
        return 0;
      case "purge-all":
        out(JSON.stringify(await ops.purgeAll()));
        return 0;
      case "backfill-owners": {
        const total = { created: [] as string[], skipped: 0, conflicts: [] as string[], invalid: [] as string[] };
        const owner = str("owner");
        let cursor: string | undefined;
        let pages = 0;
        try {
          do {
            const page = await ops.backfillOwners(owner, { cursor });
            pages++;
            total.created.push(...page.created);
            total.skipped += page.skipped;
            total.conflicts.push(...page.conflicts);
            total.invalid.push(...page.invalid);
            cursor = page.nextCursor;
          } while (cursor !== undefined);
        } catch (error) {
          // A second run skips the forms done so far. Show what this run did before the error.
          if (pages > 0) err(`backfill stopped after: ${JSON.stringify(total)}`);
          throw error;
        }
        out(JSON.stringify(total));
        return 0;
      }
      case "purge":
        out(JSON.stringify(await ops.purge(need())));
        return 0;
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      err(`${error.message}\nRun "agentic-forms --help" for usage.`);
      return 2;
    }
    if (error instanceof ZodError) err(`error: ${error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
    else if (error instanceof OpsError || error instanceof BackfillError || error instanceof FormError || error instanceof VersionConflictError || error instanceof SubmitError || error instanceof SyntaxError) err(`error: ${error.message}`);
    else throw error;
    return 1;
  }
}

const dataPath = (flags: Record<string, string | true>) =>
  typeof flags.data === "string" ? flags.data : (process.env.AGENTIC_FORMS_DATA ?? "agentic-forms.json");

function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (typeof invoked !== "string") return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).then(
    // Exit nonzero at once. On zero, fall off the end so the MCP server keeps stdio open.
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
