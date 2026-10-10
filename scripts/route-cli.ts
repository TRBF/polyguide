/** Dev CLI: pnpm route "<from place>" "<to place>" [need,need…] — prints a route on the real HG graph. */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GraphJson, Need } from '@polyguide/shared';
import { Graph, astar, costModel } from '@polyguide/routing';

const [fromQ, toQ, needsArg = ''] = process.argv.slice(2);
if (!fromQ || !toQ) {
  console.error('usage: pnpm route "<from>" "<to>" [wheelchair,blind,…]');
  process.exit(1);
}
const file = resolve(dirname(fileURLToPath(import.meta.url)), '../data/hg/graph.json');
const graph = new Graph(JSON.parse(await readFile(file, 'utf8')) as GraphJson);
const find = (q: string) => {
  const lq = q.toLowerCase();
  const p = graph.places.find((p) => p.name.toLowerCase() === lq || p.aliases.includes(lq));
  if (!p) throw new Error(`no place matches "${q}"`);
  return p;
};
const from = find(fromQ);
const to = find(toQ);
const needs = needsArg.split(',').filter(Boolean) as Need[];
const t0 = performance.now();
const model = costModel(graph, { needs });
const r = astar(graph, from.nodeId, to.nodeId, model);
const ms = performance.now() - t0;
if (!r) {
  console.log(`no route ${from.name} → ${to.name} for [${needs}] (${ms.toFixed(1)} ms)`);
  process.exit(0);
}
const dist = r.edges.reduce((s, e) => s + e.lengthM, 0);
const kinds: Record<string, number> = {};
for (const e of r.edges) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
console.log(`${from.name} (${from.nodeId}) → ${to.name} (${to.nodeId})  needs=[${needs}]`);
console.log(`  ${dist.toFixed(0)} m, cost ${r.cost.toFixed(0)} s, ${r.edges.length} edges, ${ms.toFixed(1)} ms`);
console.log('  edge kinds', kinds);
const levels = r.nodes.map((n) => graph.node(n).levelId).filter((l, i, a) => l && l !== a[i - 1]);
console.log('  levels', levels.join(' → '));
