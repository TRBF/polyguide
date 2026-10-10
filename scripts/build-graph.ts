/** Builds data/hg/graph.json from the committed ETH snapshot (SPEC §4.1). Run: pnpm build:graph. */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, type BuildInput } from '@polyguide/routing';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../data/hg');
const read = async (name: string) => JSON.parse(await readFile(resolve(DIR, name), 'utf8'));

const meta = await read('meta.json');
const input: BuildInput = {
  pathways: await read('pathways.geojson'),
  transitions: await read('transitions.geojson'),
  landmarks: await read('landmarks.geojson'),
  units: await read('units.geojson'),
  levels: await read('levels.geojson'),
  pois: await read('pois.geojson'),
  facility: 'HG',
  dataSnapshotAt: meta.fetchedAt,
};

const t0 = performance.now();
const { graph, report } = buildGraph(input);
await writeFile(resolve(DIR, 'graph.json'), JSON.stringify(graph));

const { failed, ...transitions } = report.transitions;
console.log(`built in ${(performance.now() - t0).toFixed(0)} ms → ${resolve(DIR, 'graph.json')}`);
console.log(`nodes ${report.nodes}  edges ${report.edges}  dropped nodes (not in largest component) ${report.droppedNodes}`);
console.log(`components (node counts): ${report.components.slice(0, 15).join(', ')}${report.components.length > 15 ? ` … (${report.components.length} total)` : ''}`);
console.log('transitions', transitions);
if (failed.length) {
  console.log(`transitions that failed to merge (${failed.length}):`);
  for (const f of failed) console.log(`  oid ${f.oid} ${f.kind}: ${f.reason}`);
}
console.log('dropped edges', report.droppedEdges);
console.log('length scaling', report.lengthScaling);
console.log('places', report.places);
console.log('edge kinds per level:');
for (const [lvl, kinds] of Object.entries(report.edgeKindsPerLevel).sort())
  console.log(`  ${lvl.padEnd(22)} ${Object.entries(kinds).map(([k, v]) => `${k}:${v}`).join(' ')}`);
