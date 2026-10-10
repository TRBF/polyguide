/**
 * One-off snapshot of the ETH PolyMaps ArcGIS layers for building HG → data/hg/*.geojson (SPEC §2).
 * Run: pnpm fetch:eth. Never call ETH from the server at runtime.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ETH_ARCGIS_BASE } from '@polyguide/shared';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../data/hg');
const PAGE = 2000;
const BBOX_PAD_M = 15;

type Feature = { type: 'Feature'; geometry: { type: string; coordinates: any } | null; properties: Record<string, any> };
type FC = { type: 'FeatureCollection'; features: Feature[] };
type Bbox = [number, number, number, number]; // minLon, minLat, maxLon, maxLat

async function getJson(url: string): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: any = await res.json();
      if (body.error) throw new Error(JSON.stringify(body.error));
      return body;
    } catch (err) {
      if (attempt >= 3) throw new Error(`${url}\n  → ${err}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/** Page through a layer query until exceededTransferLimit is gone. */
async function queryAll(layer: string, params: Record<string, string>): Promise<FC> {
  const features: Feature[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const qs = new URLSearchParams({
      where: '1=1',
      outFields: '*',
      outSR: '4326',
      returnZ: 'true',
      orderByFields: 'OBJECTID',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE),
      f: 'geojson',
      ...params,
    });
    const page = await getJson(`${ETH_ARCGIS_BASE}/${layer}/query?${qs}`);
    features.push(...(page.features ?? []));
    const more = page.exceededTransferLimit ?? page.properties?.exceededTransferLimit;
    if (!more || !page.features?.length) break;
  }
  return { type: 'FeatureCollection', features };
}

function envelope(bbox: Bbox) {
  const [xmin, ymin, xmax, ymax] = bbox;
  return {
    geometry: JSON.stringify({ xmin, ymin, xmax, ymax, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
  };
}

function bboxOf(fc: FC, padM: number): Bbox {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (c: any): void => {
    if (typeof c[0] === 'number') {
      minX = Math.min(minX, c[0]);
      maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1]);
      maxY = Math.max(maxY, c[1]);
    } else c.forEach(visit);
  };
  for (const f of fc.features) if (f.geometry) visit(f.geometry.coordinates);
  const lat0 = (minY + maxY) / 2;
  const dLat = padM / 110540;
  const dLon = padM / (111320 * Math.cos((lat0 * Math.PI) / 180));
  return [minX - dLon, minY - dLat, maxX + dLon, maxY + dLat];
}

function hasZ(fc: FC): boolean {
  const g = fc.features.find((f) => f.geometry)?.geometry;
  if (!g) return false;
  let c = g.coordinates;
  while (Array.isArray(c[0])) c = c[0];
  return c.length >= 3;
}

async function save(name: string, fc: FC) {
  await writeFile(resolve(OUT_DIR, `${name}.geojson`), JSON.stringify(fc));
  const levels = [...new Set(fc.features.map((f) => f.properties.LEVEL_ID).filter(Boolean))].sort();
  console.log(
    `${name.padEnd(12)} ${String(fc.features.length).padStart(5)} features  z=${hasZ(fc)}` +
      (levels.length ? `  levels: ${levels.join(' ')}` : ''),
  );
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const hg = { where: "LEVEL_ID LIKE 'ETH.HG.%'" };

  const pathways = await queryAll('EGDB_Public_Network/FeatureServer/2', hg);
  await save('pathways', pathways);
  const bbox = bboxOf(pathways, BBOX_PAD_M);
  console.log(`HG bbox (+${BBOX_PAD_M} m): ${bbox.map((v) => v.toFixed(6)).join(', ')}`);

  await save('transitions', await queryAll('EGDB_Public_Network/FeatureServer/1', envelope(bbox)));
  await save('landmarks', await queryAll('EGDB_Public_Network/FeatureServer/3', envelope(bbox)));
  await save('units', await queryAll('Units/FeatureServer/3', { where: "NAME LIKE 'HG %'" }));
  await save('levels', await queryAll('Levels/FeatureServer/4', { ...hg, orderByFields: 'VERTICAL_ORDER' }));
  await save('pois', await queryAll('PointsOfInterest/FeatureServer/0', hg));

  const meta = { fetchedAt: new Date().toISOString(), source: ETH_ARCGIS_BASE, bbox };
  await writeFile(resolve(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  console.log(`wrote ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
