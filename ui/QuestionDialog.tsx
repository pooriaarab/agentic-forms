import { useState, type FormEvent } from "react";
import { Button, Dialog, Input, Select, Switch, Textarea } from "agentic-design/react";
import type { Condition, Question, QuestionType } from "../src/core/form.js";

export const TYPES: { value: QuestionType; label: string }[] = [
  { value: "short_text", label: "Short text" },
  { value: "long_text", label: "Long text" },
  { value: "number", label: "Number" },
  { value: "email", label: "Email" },
  { value: "single_choice", label: "Single choice" },
  { value: "multi_choice", label: "Multiple choice" },
  { value: "dropdown", label: "Dropdown" },
  { value: "date", label: "Date" },
  { value: "rating", label: "Rating" },
  { value: "file", label: "File" },
];
export const typeLabel = (type: QuestionType) => TYPES.find((t) => t.value === type)?.label ?? type;
const HAS_CHOICES: QuestionType[] = ["single_choice", "multi_choice", "dropdown"];
const OPS: Condition["op"][] = ["answered", "equals", "not_equals", "contains", "gt", "lt"];
const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
const num = (text: string) => (text.trim() === "" || !Number.isFinite(Number(text)) ? undefined : Number(text));

interface Props {
  /** The question to edit, or undefined for a new one. */
  question?: Question;
  /** Questions that come earlier in the form. A condition may read only these. */
  earlier: Question[];
  taken: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (question: Question) => void;
}

export function QuestionDialog({ question, earlier, taken, open, onOpenChange, onSave }: Props) {
  const r = question?.rules ?? {};
  const [label, setLabel] = useState(question?.label ?? "");
  const [id, setId] = useState(question?.id ?? "");
  const [idTouched, setIdTouched] = useState(false);
  const [type, setType] = useState<QuestionType>(question?.type ?? "short_text");
  const [required, setRequired] = useState(question?.required ?? false);
  const [choices, setChoices] = useState((question?.choices ?? []).join("\n"));
  const [min, setMin] = useState(String(r.min ?? ""));
  const [max, setMax] = useState(String(r.max ?? ""));
  const [minLength, setMinLength] = useState(String(r.minLength ?? ""));
  const [maxLength, setMaxLength] = useState(String(r.maxLength ?? ""));
  const [condQ, setCondQ] = useState(question?.showIf?.question ?? "");
  const [condOp, setCondOp] = useState<Condition["op"]>(question?.showIf?.op ?? "answered");
  const [condValue, setCondValue] = useState(String(question?.showIf?.value ?? ""));
  const [tried, setTried] = useState(false);

  const shownId = question ? question.id : idTouched ? id : slug(label);
  const list = choices.split("\n").map((c) => c.trim()).filter(Boolean);
  const errors = {
    label: label.trim() === "" ? "Write the question." : undefined,
    id: shownId === "" ? "Give the question an id." : taken.includes(shownId) && shownId !== question?.id ? "Another question has this id." : undefined,
    choices: HAS_CHOICES.includes(type) && list.length === 0 ? "Add at least one choice, one per line." : undefined,
  };
  const bad = Object.values(errors).some(Boolean);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (bad) return;
    const rules =
      type === "number" || type === "rating"
        ? { min: num(min), max: num(max) }
        : type === "short_text" || type === "long_text" ? { minLength: num(minLength), maxLength: num(maxLength) } : {};
    const kept = Object.fromEntries(Object.entries(rules).filter(([, v]) => v !== undefined));
    const showIf: Condition | undefined = condQ === "" ? undefined : { question: condQ, op: condOp, ...(condOp === "answered" ? {} : { value: condOp === "gt" || condOp === "lt" ? Number(condValue) : condValue }) };
    // madeBy is not sent: the server sets it from the caller.
    const next: Question = { id: shownId, type, label: label.trim(), required, ...(HAS_CHOICES.includes(type) ? { choices: list } : {}), ...(Object.keys(kept).length > 0 ? { rules: kept } : {}), ...(showIf ? { showIf } : {}) };
    onSave(next);
  };
  const show = (e: string | undefined) => (tried ? e : undefined);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={question ? "Edit question" : "Add question"} description="The server checks the form logic when you save.">
      <form className="af-stack" onSubmit={submit} noValidate>
        <Input label="Question" value={label} error={show(errors.label)} onChange={(e) => setLabel(e.target.value)} />
        <Input
          label="Question id"
          hint={question ? "The id of a saved question does not change." : "Names the column in the responses table."}
          value={shownId}
          readOnly={question !== undefined}
          error={show(errors.id)}
          onChange={(e) => (setIdTouched(true), setId(e.target.value))}
        />
        <Select label="Type" value={type} onChange={(e) => setType(e.target.value as QuestionType)}>
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
        <Switch label="Required" checked={required} onChange={(e) => setRequired(e.target.checked)} />
        {HAS_CHOICES.includes(type) && <Textarea label="Choices" hint="One per line." rows={4} value={choices} error={show(errors.choices)} onChange={(e) => setChoices(e.target.value)} />}
        {(type === "number" || type === "rating") && (
          <div className="af-row">
            <Input label={type === "rating" ? "Lowest" : "Minimum"} type="number" value={min} onChange={(e) => setMin(e.target.value)} />
            <Input label={type === "rating" ? "Highest" : "Maximum"} type="number" value={max} onChange={(e) => setMax(e.target.value)} />
          </div>
        )}
        {(type === "short_text" || type === "long_text") && (
          <div className="af-row">
            <Input label="Shortest answer" type="number" min={0} value={minLength} onChange={(e) => setMinLength(e.target.value)} />
            <Input label="Longest answer" type="number" min={0} value={maxLength} onChange={(e) => setMaxLength(e.target.value)} />
          </div>
        )}
        <fieldset className="af-fieldset af-stack">
          <legend>Show only when</legend>
          <Select label="Earlier question" value={condQ} onChange={(e) => setCondQ(e.target.value)} hint={earlier.length === 0 ? "No earlier question yet." : undefined}>
            <option value="">Always show</option>
            {earlier.map((q) => (
              <option key={q.id} value={q.id}>
                {q.label}
              </option>
            ))}
          </Select>
          {condQ !== "" && (
            <>
              <Select label="Condition" value={condOp} onChange={(e) => setCondOp(e.target.value as Condition["op"])}>
                {OPS.map((op) => (
                  <option key={op} value={op}>
                    {op.replace("_", " ")}
                  </option>
                ))}
              </Select>
              {condOp !== "answered" && <Input label="Value" value={condValue} onChange={(e) => setCondValue(e.target.value)} />}
            </>
          )}
        </fieldset>
        <div className="af-row">
          <Button type="submit" variant="primary">
            {question ? "Save question" : "Add question"}
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
