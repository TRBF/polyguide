/**
 * One-off snapshot of the ETH Room Information photos and facts for building HG → data/hg/room-photos/.
 * The voice agent compares a camera frame with these to tell which room the user is in (POST /api/locate-room).
 * Only teaching, meeting and exhibition rooms have photos (~74 in HG); corridors and offices do not.
 *
 * Source (public, no login): https://ethz.ch/bin/ethz/roominfo?path=/rooms (list + facts),
 * ?path=/v2/rooms/<room> (photo ids), ?path=/v2/files/<id> (JPEG, 1600 px). Photos are resized to 512 px with
 * ImageMagick (`magick` on PATH). Run: pnpm fetch:room-photos. Never call ETH from the server at runtime.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://ethz.ch/bin/ethz/roominfo?path=';
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../data/hg/room-photos');
const BUILDING = 'HG';
const MAX_PHOTOS = 3;
const SIZE_PX = 512;

interface RoomFacts {
  building: string;
  floor: string;
  room: string;
  type: string;
  seats: string | null;
  seating: string;
  floorArea: number | null;
  usableHeight: number | null;
  floorShape: string;
}

export interface RoomPhotoEntry {
  /** "HG F 30", matching Place.name in graph.json. */
  name: string;
  type: string;
  seats: number | null;
  seating: string;
  floorShape: string;
  floorAreaM2: number | null;
  heightM: number | null;
  /** Files in data/hg/room-photos/. */
  photos: string[];
}

async function get(url: string, as: 'json' | 'buffer'): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'PolyGuide snapshot (polyguide hackathon)' }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return as === 'json' ? await res.json() : Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt >= 3) throw new Error(`${url}\n  → ${err}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function main() {
  const rooms = ((await get(`${BASE}/rooms&lang=en`, 'json')) as RoomFacts[]).filter((r) => r.building === BUILDING);
  console.log(`${rooms.length} ${BUILDING} rooms in Room Information`);
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  const index: RoomPhotoEntry[] = [];
  for (const r of rooms) {
    const name = `${r.building} ${r.floor} ${r.room}`;
    const detail = await get(`${BASE}/v2/rooms/${encodeURIComponent(name)}&lang=en`, 'json');
    const d = Array.isArray(detail) ? detail[0] : detail;
    const images: { id: number }[] = (d?.tabs ?? []).flatMap((t: any) => t?.attachments?.images ?? []);
    const photos: string[] = [];
    for (const img of images.slice(0, MAX_PHOTOS)) {
      const file = `${name.replace(/\s+/g, '_')}_${photos.length + 1}.jpg`;
      const jpeg: Buffer = await get(`${BASE}/v2/files/${img.id}`, 'buffer');
      const small = execFileSync('magick', ['-', '-resize', `${SIZE_PX}x${SIZE_PX}>`, '-strip', '-quality', '72', 'jpg:-'], { input: jpeg, maxBuffer: 20 * 1024 * 1024 });
      await writeFile(resolve(OUT_DIR, file), small);
      photos.push(file);
    }
    index.push({
      name,
      type: r.type,
      seats: r.seats ? Number(r.seats) : null,
      seating: r.seating,
      floorShape: r.floorShape,
      floorAreaM2: r.floorArea,
      heightM: r.usableHeight,
      photos,
    });
    console.log(`${name.padEnd(12)} ${r.type.padEnd(20)} ${photos.length} photo(s)`);
  }
  await writeFile(resolve(OUT_DIR, 'index.json'), `${JSON.stringify({ source: 'https://ethz.ch/staffnet/en/service/rooms-and-buildings/roominfo.html', fetchedAt: new Date().toISOString(), rooms: index }, null, 1)}\n`);
  console.log(`${index.filter((r) => r.photos.length).length} rooms with photos → ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
