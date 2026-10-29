import { useState } from "react";
import { Checkbox, Input, Select, Textarea } from "agentic-design/react";
import { visibleQuestions, type AnswerValue, type Answers, type Form, type Question } from "../src/core/form.js";

function Field({ q, value, set }: { q: Question; value: AnswerValue | undefined; set: (v: AnswerValue | undefined) => void }) {
  const label = q.required ? `${q.label} (required)` : q.label;
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  switch (q.type) {
    case "long_text":
      return <Textarea label={label} rows={4} value={text} onChange={(e) => set(e.target.value || undefined)} />;
    case "dropdown":
      return (
        <Select label={label} value={text} onChange={(e) => set(e.target.value || undefined)}>
          <option value="">Select one</option>
          {(q.choices ?? []).map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
      );
    case "single_choice":
    case "rating": {
      const lo = q.rules?.min ?? 1;
      const options = q.type === "rating" ? Array.from({ length: Math.max(0, (q.rules?.max ?? 5) - lo + 1) }, (_, i) => String(lo + i)) : (q.choices ?? []);
      return (
        <fieldset className="af-fieldset">
          <legend>{label}</legend>
          {options.map((o) => (
            <label className="af-opt" key={o}>
              <input type="radio" name={q.id} checked={text === o} onChange={() => set(q.type === "rating" ? Number(o) : o)} /> {o}
            </label>
          ))}
        </fieldset>
      );
    }
    case "multi_choice": {
      const picked = Array.isArray(value) ? value : [];
      return (
        <fieldset className="af-fieldset">
          <legend>{label}</legend>
          {(q.choices ?? []).map((c) => (
            <Checkbox key={c} label={c} checked={picked.includes(c)} onChange={(e) => set(e.target.checked ? [...picked, c] : picked.filter((p) => p !== c))} />
          ))}
        </fieldset>
      );
    }
    case "file":
      return <Input label={`${label}: files are not supported in the form page yet`} disabled value="" readOnly />;
    default: {
      const type = q.type === "number" ? "number" : q.type === "email" ? "email" : q.type === "date" ? "date" : "text";
      return <Input label={label} type={type} value={text} onChange={(e) => set(e.target.value === "" ? undefined : type === "number" ? Number(e.target.value) : e.target.value)} />;
    }
  }
}

/** A live preview. It shows and hides questions by their conditions and sends nothing. */
export function Preview({ form }: { form: Form }) {
  const [answers, setAnswers] = useState<Answers>({});
  const shown = new Set(visibleQuestions(form, answers).map((q) => q.id));
  return (
    <div className="af-stack">
      <p className="af-muted">This is how the form looks. Nothing you type here is sent or saved.</p>
      <div className="af-card af-stack">
        <h2 className="af-title">{form.title}</h2>
        {form.sections.map((s) => (
          <section key={s.id} className="af-stack" aria-label={s.title}>
            <h3 style={{ margin: 0 }}>{s.title}</h3>
            {s.questions.filter((q) => shown.has(q.id)).map((q) => (
              <Field key={q.id} q={q} value={answers[q.id]} set={(v) => setAnswers((a) => { const n = { ...a }; if (v === undefined) delete n[q.id]; else n[q.id] = v; return n; })} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
