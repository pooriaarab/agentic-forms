// The public fill page: one self-contained HTML document. No CDN, no third-party
// script. The look comes from the agentic-design tokens, which the Worker serves at /ui/styles.css (self-hosted fonts); system fonts remain the fallback. Built for WCAG 2.2 AA: labels on every control,
// visible focus, 40px targets (AA 2.5.8 needs 24px), a text error summary, and no color-only cues.
import type { Form, Question } from "./core/form.js";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c]);

const STYLE = `
body{margin:0;font:var(--agd-font-size-md,1rem)/1.6 var(--agd-font-family-sans,system-ui,sans-serif);color:var(--agd-color-text,#1a1a1a);background:var(--agd-color-bg,#fff)}
main{max-width:36rem;margin:0 auto;padding:3rem 1.25rem 5rem}
h1{font-size:var(--agd-font-size-xl,1.5rem);line-height:1.25;margin:0 0 2rem;font-weight:600;letter-spacing:-.01em}
fieldset{border:1px solid var(--agd-color-border,#d4d4d8);border-radius:var(--agd-radius-md,8px);padding:1rem 1.25rem;margin:0 0 1.5rem;background:var(--agd-color-surface,#fff)}
legend{font-weight:500;padding:0 .25rem}
label{display:block;font-weight:500;margin:1.25rem 0 .375rem}
.opt{display:flex;gap:.625rem;align-items:center;min-height:2.5rem}
.opt label{margin:0;font-weight:400}
input[type=checkbox],input[type=radio]{width:1.25rem;height:1.25rem;flex:none;accent-color:var(--agd-color-accent,#0b57d0)}
input:not([type=checkbox]):not([type=radio]),textarea,select{width:100%;box-sizing:border-box;min-height:2.5rem;padding:.5rem .75rem;font:inherit;color:inherit;background:var(--agd-color-surface,#fff);border:1px solid var(--agd-color-border-strong,#595959);border-radius:var(--agd-radius-md,8px)}
:focus-visible{outline:2px solid var(--agd-color-focus,#0b57d0);outline-offset:2px}
button{min-height:2.5rem;padding:.5rem 1.5rem;font:inherit;font-weight:500;color:var(--agd-color-text-on-accent,#fff);background:var(--agd-color-accent,#0b57d0);border:1px solid var(--agd-color-accent,#0b57d0);border-radius:var(--agd-radius-md,8px);cursor:pointer}
#errors{border:1px solid var(--agd-color-danger,#b3261e);border-radius:var(--agd-radius-md,8px);background:var(--agd-color-danger-subtle,#fff);padding:1rem;margin:0 0 1.5rem}
#done{padding:1.5rem;border:1px solid var(--agd-color-border,#d4d4d8);border-radius:var(--agd-radius-md,8px)}
.req{font-weight:400}
.notice{white-space:pre-line}
[hidden]{display:none!important}`;

// Mirrors the server rules in core/form.ts to show and hide questions. The
// server stays the authority and checks every answer again.
const SCRIPT = `
const form=JSON.parse(document.getElementById("form-data").textContent);
const el=document.getElementById("form"),errors=document.getElementById("errors"),done=document.getElementById("done");
const named=(id)=>[...el.elements].filter((n)=>n.name===id);
const match=(c,a)=>{const v=a[c.question],eq=Array.isArray(v)?v.includes(c.value):v===c.value;
switch(c.op){case"answered":return v!==undefined&&v!==""&&!(Array.isArray(v)&&!v.length);case"equals":return eq;case"not_equals":return!eq;
case"contains":return typeof v==="string"?typeof c.value==="string"&&v.includes(c.value):Array.isArray(v)&&v.includes(c.value);
case"gt":return typeof v==="number"&&v>c.value;case"lt":return typeof v==="number"&&v<c.value}return false};
const read=(q)=>{const n=named(q.id);if(!n.length)return undefined;
if(q.type==="multi_choice")return n.filter((x)=>x.checked).map((x)=>x.value);
if(q.type==="single_choice"||q.type==="rating"){const x=n.find((i)=>i.checked);return x?(q.type==="rating"?Number(x.value):x.value):undefined}
if(n[0].value==="")return undefined;return q.type==="number"?Number(n[0].value):n[0].value};
const walk=(apply)=>{const seen={};form.sections.forEach((s,i)=>{const fs=el.querySelector('[data-s="'+i+'"]');
const sv=!s.showIf||match(s.showIf,seen);if(fs)fs.hidden=!sv;
s.questions.forEach((q,j)=>{const w=el.querySelector('[data-q="'+i+"-"+j+'"]');if(!w)return;
const qv=sv&&(!q.showIf||match(q.showIf,seen));w.hidden=!qv;named(q.id).forEach((n)=>{n.disabled=!qv});
if(qv){const v=read(q);if(v!==undefined)seen[q.id]=v;if(apply)apply(q,v)}})})};
el.addEventListener("input",()=>walk());el.addEventListener("change",()=>walk());walk();
const fail=(lines)=>{errors.replaceChildren();const h=document.createElement("h2");h.textContent="We could not send your answers";
const ul=document.createElement("ul");lines.forEach((t)=>{const li=document.createElement("li");li.textContent=t;ul.append(li)});
errors.append(h,ul);errors.hidden=false;errors.focus()};
el.addEventListener("submit",async(e)=>{e.preventDefault();errors.hidden=true;const answers={};
walk((q,v)=>{if(v!==undefined)answers[q.id]=v});const body={answers};
if(el.elements.consent)body.consent=el.elements.consent.checked;
let res;try{res=await fetch(location.pathname,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)})}
catch{return fail(["The network failed. Check your connection and try again."])}
if(res.status===201){el.hidden=true;done.hidden=false;done.focus();return}
if(res.status===422){const j=await res.json();const label=(id)=>{for(const s of form.sections)for(const q of s.questions)if(q.id===id)return q.label;return"Consent"};
return fail(j.issues.map((i)=>label(i.question)+": "+i.message))}
fail([res.status===429?"Too many tries. Wait a minute, then try again.":"Something is wrong on our side. Try again later."])});`;

function control(q: Question, n: number, name: string, req: string): string {
  const need = q.required ? ' required aria-required="true"' : "";
  const id = `q-${n}`;
  const label = `<label for="${id}">${esc(q.label)}${req}</label>`;
  const r = q.rules ?? {};
  switch (q.type) {
    case "long_text":
      return `${label}<textarea id="${id}" name="${name}" rows="5"${need}${r.maxLength ? ` maxlength="${r.maxLength}"` : ""}></textarea>`;
    case "number":
      return `${label}<input id="${id}" name="${name}" type="number" step="any" inputmode="decimal"${need}${r.min !== undefined ? ` min="${r.min}"` : ""}${r.max !== undefined ? ` max="${r.max}"` : ""}>`;
    case "email":
      return `${label}<input id="${id}" name="${name}" type="email" autocomplete="email"${need}>`;
    case "date":
      return `${label}<input id="${id}" name="${name}" type="date"${need}>`;
    case "dropdown":
      return `${label}<select id="${id}" name="${name}"${need}><option value="">Select one</option>${(q.choices ?? []).map((c) => `<option>${esc(c)}</option>`).join("")}</select>`;
    case "single_choice":
    case "multi_choice":
    case "rating": {
      const kind = q.type === "multi_choice" ? "checkbox" : "radio";
      const options =
        q.type === "rating"
          ? Array.from({ length: (r.max ?? 5) - (r.min ?? 1) + 1 }, (_, i) => String((r.min ?? 1) + i))
          : (q.choices ?? []);
      const items = options
        .map((o, i) => `<div class="opt"><input id="r-${n}-${i}" type="${kind}" name="${name}" value="${esc(o)}"${kind === "radio" ? need : ""}><label for="r-${n}-${i}">${esc(o)}</label></div>`)
        .join("");
      return `<fieldset><legend>${esc(q.label)}${req}</legend>${items}</fieldset>`;
    }
    default:
      return `${label}<input id="${id}" name="${name}" type="text"${need}${r.maxLength ? ` maxlength="${r.maxLength}"` : ""}>`;
  }
}

/** Renders a published form. File questions are not shown: the page has no upload. */
export function renderFillPage(form: Form, nonce: string): string {
  let n = 0;
  const sections = form.sections
    .map((section, i) => {
      const questions = section.questions
        .map((q, j) => {
          if (q.type === "file") return "";
          const req = q.required ? ' <span class="req">(required)</span>' : "";
          return `<div data-q="${i}-${j}">${control(q, n++, esc(q.id), req)}</div>`;
        })
        .join("");
      return `<fieldset data-s="${i}"><legend>${esc(section.title)}</legend>${questions}</fieldset>`;
    })
    .join("");
  const notice =
    form.notice === undefined
      ? ""
      : `<section aria-labelledby="notice-h"><h2 id="notice-h">Privacy notice</h2><p class="notice">${esc(form.notice)}</p>${
          form.retentionDays ? `<p>We keep your answers for ${form.retentionDays} days.</p>` : ""
        }<div class="opt"><input id="consent" name="consent" type="checkbox" required aria-required="true"><label for="consent">I have read the notice and agree <span class="req">(required)</span></label></div></section>`;
  // madeBy is an editing detail: the page data leaves it out.
  const plain = form.sections.map((s) => ({ ...s, questions: s.questions.map(({ madeBy: _by, ...q }) => q) }));
  const data = JSON.stringify({ sections: plain }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(form.title)}</title><link rel="stylesheet" href="/ui/styles.css"><style nonce="${nonce}">${STYLE}</style></head><body><main><h1>${esc(form.title)}</h1><div id="done" role="status" tabindex="-1" hidden><h2>Thank you</h2><p>We received your answers.</p></div><form id="form"><div id="errors" role="alert" tabindex="-1" hidden></div>${sections}${notice}<p><button type="submit">Send</button></p></form></main><script type="application/json" id="form-data" nonce="${nonce}">${data}</script><script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}
