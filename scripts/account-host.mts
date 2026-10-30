// Failure cases: packed types/exports missing; registry rejects JSON; principal kinds
// collide; shared responses vanish; bad grants pass; failed erase cannot be retried.
import { formsAccount, type FormsAccountDeps } from 'agentic-forms/account';
import { createOps } from 'agentic-forms';
import { createAccountRegistry, type AccountPackage } from 'agentic-identity/account';
import { createMemoryStore, createSharing, PRINCIPAL_KINDS, type PrincipalContext } from 'agentic-identity';
const contributor: AccountPackage<FormsAccountDeps> = formsAccount;
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const store = createMemoryStore();
const sharing = createSharing(store);
const ops = createOps(store);
const subject = { id: 'ana', kind: 'human' } as const;
const context = (id: string, kind: 'human' | 'agent' = 'human'): PrincipalContext => ({ principalId: id, kind, chain: [{ id, kind }], scopes: ['*:admin'] });
async function make(id: string, owner: string, kind: 'human' | 'agent' = 'human') {
  await sharing.createResource(context(owner, kind), { id, type: 'form' });
  await ops.create({ id, title: id, sections: [{ id: 's', title: 'S', questions: [{ id: 'q', type: 'short_text', label: 'Q' }] }] }, true);
  await ops.submit(id, { q: `${id}-answer` });
}
const registry = createAccountRegistry().register(contributor, { store });
await make('mine', 'ana');
await make('agent-owned', 'ana', 'agent');
await make('shared', 'bob');
await sharing.grant(context('bob'), 'shared', subject, 'owner');
await make('other', 'bob');
for (const kind of PRINCIPAL_KINDS) {
  await store.put('audit', `root-${kind}`, { rootId: subject.id, chain: [{ id: subject.id, kind }], resourceId: 'shared' });
}
for (const kind of PRINCIPAL_KINDS) {
  const data = await formsAccount.exportAccount({ id: subject.id, kind }, { store });
  check(data.audit.some(a => a.chain && JSON.stringify(a.chain) === JSON.stringify([{ id: subject.id, kind }])), 'missing principal audit');
  check(data.audit.every(a => Array.isArray(a.chain) && a.chain[0] && typeof a.chain[0] === 'object' && 'kind' in a.chain[0] && a.chain[0].kind === kind), 'principal collision');
  const archive = await registry.export({ id: subject.id, kind });
  check(archive.manifest.apps[0]?.id === 'forms', 'registry manifest');
  if (kind === 'agent') check(data.forms.length === 1 && data.forms[0]?.id === 'agent-owned', 'agent ownership missing');
  else if (kind !== 'human') check(data.forms.length === 0, 'principal inherits ownership');
}
const archive = await registry.export(subject);
check(new TextDecoder().decode(archive.zip).includes('mine-answer'), 'published response absent');
await store.put('grants', 'bad', { resourceId: 'mine', subjectId: subject.id, role: 'owner' });
let refused = false;
try { await registry.export(subject); } catch { refused = true; }
check(refused, 'malformed grant export accepted');
check(!(await registry.erase(subject, store, { actor: null })).ok, 'malformed grant erase accepted');
check(await store.get('forms', 'mine'), 'malformed grant lost data');
await store.delete('grants', 'bad');
const transaction = store.transaction.bind(store);
store.transaction = async () => { throw new Error('injected storage failure'); };
check(!(await registry.erase(subject, store, { actor: null })).ok, 'partial erase reported success');
check(await store.get('resources', 'mine'), 'retry anchor lost');
store.transaction = transaction;
check((await registry.erase(subject, store, { actor: null })).ok, 'retry failed');
check(await store.get('forms', 'mine') === null, 'sole form remains');
check(await store.get('forms', 'shared'), 'shared form removed');
check(await store.get('forms', 'agent-owned'), 'same-id agent form removed');
check((await ops.listResponses('shared')).items.length === 1, 'shared answers removed');
check(await store.get('grants', 'shared:human:ana') === null, 'subject grant remains');
check(await store.get('grants', 'shared:human:bob'), 'other owner grant removed');
for (const kind of PRINCIPAL_KINDS.filter(k => k !== 'human')) {
  check(await store.get('audit', `root-${kind}`), 'other principal audit removed');
  check((await registry.erase({ id: subject.id, kind }, store, { actor: null })).ok, 'principal erase failed');
  check(await store.get('audit', `root-${kind}`) === null, 'principal audit remains');
}
const again = await registry.erase(subject, store, { actor: null });
check(again.ok && Object.values(again.counts.forms ?? {}).every(n => n === 0), 'retry counts not zero');
check((await ops.listResponses('other')).items.length === 1, 'other answers removed');
console.log('Packed account host: types, registry, all principal kinds, ownership, malformed grants, partial erase and retry PASS');
