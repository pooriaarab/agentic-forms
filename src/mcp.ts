import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, ZodError } from "zod";
import { FormError } from "./core/repo.js";
import { createMemoryStore, type Store } from "agentic-identity";
import { SubmitError } from "./core/responses.js";
import { formSpecSchema, formUpdateSchema, questionSchema } from "./core/schema.js";
import { OpsError, createOps } from "./ops.js";
import { VERSION } from "./version.js";

const answersSchema = z.record(z.union([z.string(), z.number(), z.array(z.string())]));

function describe(error: unknown): string | undefined {
  if (error instanceof ZodError) return error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  if (error instanceof OpsError || error instanceof FormError || error instanceof SubmitError) return error.message;
  return undefined;
}

export function createMcpServer(store: Store = createMemoryStore()): McpServer {
  const ops = createOps(store);
  const server = new McpServer({ name: "agentic-forms", version: VERSION });
  // Tool args are checked by each tool's zod shape before `run` sees them.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (name: string, description: string, shape: z.ZodRawShape, readOnly: boolean, run: (args: any) => Promise<unknown>) =>
    server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: readOnly } }, async (args: unknown): Promise<CallToolResult> => {
      try {
        const value = await run(args);
        return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
      } catch (error) {
        const message = describe(error);
        if (message === undefined) throw error;
        return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
      }
    });

  const form = { form: z.string().describe("The form id.") };
  tool("new_form", "Make a form from a structured spec. Pass publish true to open it at once.", { ...formSpecSchema.shape, publish: z.boolean().optional() }, false, ({ publish, ...spec }) => ops.create(spec, publish === true, "agent"));
  tool("add_question", "Add one question to a form. Editing a published form starts a new draft version.", { ...form, section: z.string().optional(), question: questionSchema }, false, ({ form: id, section, question }) => ops.addQuestion(id, question, section, "agent"));
  tool("update_form", "Replace a form's title, notice, retention, and sections. Use it to edit, reorder, or remove questions. Editing a published form starts a new draft version.", { ...form, ...formUpdateSchema.shape }, false, ({ form: id, ...spec }) => ops.update(id, spec, "agent"));
  tool("publish_form", "Open the form to answers.", form, false, ({ form: id }) => ops.publish(id));
  tool("get_form", "Read a form.", form, true, ({ form: id }) => ops.get(id));
  tool("submit_response", "Store one response. Pass consent true when the form has a notice.", { ...form, answers: answersSchema, consent: z.boolean().optional() }, false, ({ form: id, answers, consent }) => ops.submit(id, answers, consent === true));
  tool("list_responses", "List responses as rows, oldest first.", { ...form, limit: z.number().int().min(1).max(500).optional(), cursor: z.string().optional() }, true, ({ form: id, ...page }) => ops.listResponses(id, page));
  tool("export_csv", "Export every response as CSV.", form, true, ({ form: id }) => ops.exportCsv(id));
  tool("purge_expired", "Delete responses past the retention period.", form, false, ({ form: id }) => ops.purge(id));
  tool("purge_all", "Delete expired responses of every form.", {}, false, () => ops.purgeAll());
  return server;
}

export async function startMcp(store?: Store): Promise<void> {
  await createMcpServer(store).connect(new StdioServerTransport());
}
