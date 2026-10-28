// Input schemas for the CLI, the MCP tools, and the HTTP API. An agent that
// builds a form writes JSON that matches formSpecSchema. No model runs here.
import { z } from "zod";

const id = z.string().min(1).max(100);
const condition = z
  .object({
    question: id,
    op: z.enum(["equals", "not_equals", "contains", "gt", "lt", "answered"]),
    value: z.union([z.string(), z.number()]).optional(),
  })
  .strict();

export const questionSchema = z
  .object({
    id,
    type: z.enum(["short_text", "long_text", "number", "email", "single_choice", "multi_choice", "dropdown", "date", "rating", "file"]),
    label: z.string().min(1).max(500),
    required: z.boolean().default(false),
    choices: z.array(z.string().min(1).max(200)).max(200).optional(),
    rules: z
      .object({ minLength: z.number(), maxLength: z.number(), pattern: z.string(), min: z.number(), max: z.number() })
      .partial()
      .strict()
      .optional(),
    showIf: condition.optional(),
  })
  .strict();

export const formSpecSchema = z
  .object({
    id,
    title: z.string().min(1).max(200),
    notice: z.string().optional(),
    retentionDays: z.number().optional(),
    sections: z
      .array(z.object({ id, title: z.string().min(1).max(200), showIf: condition.optional(), questions: z.array(questionSchema) }).strict())
      .min(1),
  })
  .strict();

export type FormSpec = z.infer<typeof formSpecSchema>;
export type QuestionSpec = z.infer<typeof questionSchema>;
