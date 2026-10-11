import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { RouteResult, RouteStep } from '@polyguide/shared';
import { api, type FloorMap } from './api';

type Route = Extract<RouteResult, { ok: true }>;
type LonLat = [number, number];
interface XY {
  x: number;
  y: number;
}
interface MapFeature {
  geometry?: { type: string; coordinates: unknown } | null;
  properties?: Record<string, unknown>;
}
interface View {
  cx: number;
  cy: number;
  /** Half the visible width in metres. */
  half: number;
}

/** The map frame is 3:2; the drawing is in metres, so zoom and pan only change the viewBox. */
const ASPECT = 2 / 3;
const FIT_MARGIN_M = 12;
const MIN_HALF_M = 8;
const MAX_HALF_M = 220;

const floorOf = (levelId: string) => levelId.split('.').at(-1) ?? levelId;
const shortRoom = (name: string) => name.replace(/^HG\s+/, '');
const isVertical = (s: RouteStep) => Boolean(s.toLevelId && s.toLevelId !== s.levelId);
const isPos = (v: unknown): v is LonLat => Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number';
const ring = (v: unknown): LonLat[] => (Array.isArray(v) ? v.filter(isPos) : []);

/** Outer rings of a Polygon / MultiPolygon. */
function outerRings(feature: MapFeature): LonLat[][] {
  const g = feature.geometry;
  if (!g || !Array.isArray(g.coordinates)) return [];
  if (g.type === 'Polygon') return [ring(g.coordinates[0])];
  if (g.type === 'MultiPolygon') return g.coordinates.map((poly) => ring(Array.isArray(poly) ? poly[0] : []));
  return [];
}

type StepState = 'done' | 'current' | 'next';

const floorCache = new Map<string, { promise: Promise<FloorMap>; value?: FloorMap }>();
function loadFloor(levelId: string): Promise<FloorMap> {
  const hit = floorCache.get(levelId);
  if (hit) return hit.promise;
  const entry: { promise: Promise<FloorMap>; value?: FloorMap } = { promise: Promise.resolve(null as unknown as FloorMap) };
  entry.promise = api.floorMap(levelId).then(
    (data) => { entry.value = data; return data; },
    (err) => { floorCache.delete(levelId); throw err; },
  );
  floorCache.set(levelId, entry);
  return entry.promise;
}

interface Props {
  route: Route;
  levelId: string;
  /** Navigate screen: highlight progress and follow the current step. */
  activeStepIndex?: number;
  compact?: boolean;
}

export function RouteMap({ route, levelId, activeStepIndex, compact = false }: Props) {
  const [floorMap, setFloorMap] = useState<FloorMap | null>(null);
  const [mapError, setMapError] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [pxWidth, setPxWidth] = useState(600);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ x: number; y: number; view: View } | null>(null);

  // One cached request per floor, shared by every map (preview + navigate); a failed load can be retried.
  useEffect(() => {
    let cancelled = false;
    setMapError(false);
    setFloorMap(floorCache.get(levelId)?.value ?? null);
    loadFloor(levelId)
      .then((data) => { if (!cancelled) setFloorMap(data); })
      .catch(() => { if (!cancelled) setMapError(true); });
    return () => { cancelled = true; };
  }, [levelId]);

  // Labels keep a constant on-screen size, so we need the rendered width.
  useEffect(() => {
    const el = svgRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setPxWidth(Math.max(200, entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ── Local metric projection around the route (north up). ── */
  const origin = route.steps[0]?.polyline[0] ?? ([route.to.lon, route.to.lat] as LonLat);
  const kx = Math.cos((origin[1] * Math.PI) / 180) * 111320;
  const toXY = ([lon, lat]: LonLat): XY => ({ x: (lon - origin[0]) * kx, y: -(lat - origin[1]) * 110540 });
  const pts = (line: LonLat[]) => line.map(toXY).map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');

  const features = (floorMap?.features ?? []) as MapFeature[];
  const rooms = useMemo(() => features.filter((f) => f.properties?.layer === 'room'), [features]);

  const stepsHere = route.steps.filter((s) => s.levelId === levelId && !isVertical(s) && s.polyline.length > 1);
  const stateOf = (s: RouteStep): StepState =>
    activeStepIndex == null ? 'next' : s.index < activeStepIndex ? 'done' : s.index === activeStepIndex ? 'current' : 'next';

  /* ── Rooms the route passes on this floor get short labels, like the signs you'll see. ── */
  const passedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of route.steps) if (s.levelId === levelId) for (const l of s.expectedLandmarks) if (l.placeId && l.kind === 'room_sign') ids.add(l.placeId);
    ids.add(route.to.id);
    return ids;
  }, [route, levelId]);
  const roomLabels = useMemo(() => {
    const out: { id: string; text: string; at: XY; destination: boolean }[] = [];
    for (const f of rooms) {
      const id = f.properties?.placeId;
      const name = f.properties?.name;
      if (typeof id !== 'string' || typeof name !== 'string' || !passedIds.has(id)) continue;
      const r = outerRings(f)[0];
      if (!r?.length) continue;
      const c = r.map(toXY).reduce((a, p) => ({ x: a.x + p.x / r.length, y: a.y + p.y / r.length }), { x: 0, y: 0 });
      out.push({ id, text: shortRoom(name), at: c, destination: id === route.to.id });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, passedIds]);

  /* ── Markers: start, numbered turns, floor changes, destination. ── */
  type Marker = { at: XY; kind: 'start' | 'turn' | 'transfer' | 'end'; glyph: string; label?: string; state: StepState };
  const markers: Marker[] = [];
  const first = route.steps[0];
  if (first?.levelId === levelId && first.polyline[0]) markers.push({ at: toXY(first.polyline[0]), kind: 'start', glyph: 'S', label: 'Start', state: stateOf(first) });
  for (const s of route.steps) {
    if (isVertical(s)) {
      const what = s.maneuver === 'take_elevator' ? 'Elevator' : s.maneuver.startsWith('take_ramp') ? 'Ramp' : 'Stairs';
      if (s.levelId === levelId && s.polyline[0]) markers.push({ at: toXY(s.polyline[0]), kind: 'transfer', glyph: '↕', label: `${what} to ${floorOf(s.toLevelId!)}`, state: stateOf(s) });
      const exit = s.polyline.at(-1);
      if (s.toLevelId === levelId && exit) markers.push({ at: toXY(exit), kind: 'transfer', glyph: '↕', label: `${what} from ${floorOf(s.levelId)}`, state: stateOf(s) });
    } else if (s.index > 0 && s.levelId === levelId && s.maneuver !== 'arrive' && s.polyline[0] && !isVertical(route.steps[s.index - 1])) {
      markers.push({ at: toXY(s.polyline[0]), kind: 'turn', glyph: String(s.index + 1), state: stateOf(s) });
    }
  }
  const last = route.steps.at(-1);
  if (last?.maneuver === 'arrive' && last.levelId === levelId && last.polyline[0]) markers.push({ at: toXY(last.polyline[0]), kind: 'end', glyph: '●', label: route.to.label ?? shortRoom(route.to.name), state: stateOf(last) });

  /* ── Fit: the current step (navigating) or the whole route on this floor. ── */
  const fitView = (): View => {
    const focus = activeStepIndex != null ? route.steps[activeStepIndex] : undefined;
    const focusLines = focus && focus.levelId === levelId && !isVertical(focus) ? [focus.polyline] : stepsHere.map((s) => s.polyline);
    let xy = focusLines.flat().map(toXY);
    if (!xy.length) xy = markers.map((m) => m.at);
    if (!xy.length) xy = rooms.flatMap((f) => outerRings(f).flat().map(toXY));
    if (!xy.length) return { cx: 0, cy: 0, half: 40 };
    const xs = xy.map((p) => p.x);
    const ys = xy.map((p) => p.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const half = Math.min(MAX_HALF_M, Math.max(MIN_HALF_M * 2, (maxX - minX) / 2 + FIT_MARGIN_M, ((maxY - minY) / 2 + FIT_MARGIN_M) / ASPECT));
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, half };
  };
  const fitKey = `${route.routeId}|${levelId}|${activeStepIndex ?? ''}|${floorMap ? 1 : 0}`;
  useEffect(() => setView(fitView()), [fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const v = view ?? fitView();
  const vb = { x: v.cx - v.half, y: v.cy - v.half * ASPECT, w: v.half * 2, h: v.half * 2 * ASPECT };
  /** Metres per CSS pixel: multiply a px size by this to draw it at a constant screen size. */
  const u = vb.w / pxWidth;

  const zoom = (factor: number) => setView({ ...v, half: Math.min(MAX_HALF_M, Math.max(MIN_HALF_M, v.half * factor)) });
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    drag.current = { x: e.clientX, y: e.clientY, view: v };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    setView({ ...d.view, cx: d.view.cx - (e.clientX - d.x) * u, cy: d.view.cy - (e.clientY - d.y) * u });
  };
  const onPointerUp = () => { drag.current = null; };

  const floor = floorOf(levelId);
  const routeHere = stepsHere.length > 0;
  const caption = routeHere
    ? `Floor ${floor}. Your route is the blue line${markers.some((m) => m.kind === 'turn') ? '; numbers match the steps' : ''}.${markers.filter((m) => m.label).map((m) => ` ${m.label}.`).join('')}`
    : `Floor ${floor}. Your route does not walk on this floor.`;

  return (
    <figure className={`map-figure${compact ? ' map-figure-compact' : ''}`}>
      {mapError && <p className="map-note">The floor drawing could not load. The written steps still give the full route.</p>}
      <div className="map-stage">
        <svg
          ref={svgRef}
          className="route-map"
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          role="img"
          aria-label={caption}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <rect className="map-background" x={vb.x} y={vb.y} width={vb.w} height={vb.h} />
          <g className="map-rooms">
            {rooms.map((f, i) =>
              outerRings(f).map((r, j) => (
                <polygon key={`${i}-${j}`} className={f.properties?.placeId === route.to.id ? 'map-room map-room-destination' : 'map-room'} points={pts(r)} />
              )),
            )}
          </g>
          <g className="map-route">
            {stepsHere.map((s) => (
              <g key={s.index} className={`map-leg map-leg-${stateOf(s)}`}>
                <polyline className="map-route-outline" points={pts(s.polyline)} strokeWidth={14 * u} />
                <polyline className="map-route-line" points={pts(s.polyline)} strokeWidth={(stateOf(s) === 'current' ? 9 : 7) * u} />
              </g>
            ))}
          </g>
          <g className="map-room-labels">
            {roomLabels.map((l) => (
              <text key={l.id} className={l.destination ? 'map-room-label map-room-label-destination' : 'map-room-label'} x={l.at.x} y={l.at.y} fontSize={13 * u} strokeWidth={4 * u}>
                {l.text}
              </text>
            ))}
          </g>
          <g className="map-markers">
            {markers.map((m, i) => {
              const r = (m.kind === 'turn' ? 12 : 17) * u;
              const labelW = m.label ? (m.label.length * 9.5 + 20) * u : 0;
              const flip = m.at.x + r + 8 * u + labelW > vb.x + vb.w;
              const lx = flip ? m.at.x - r - 8 * u - labelW : m.at.x + r + 8 * u;
              return (
                <g key={i} className={`map-marker map-marker-${m.kind} map-marker-${m.state}`}>
                  <circle cx={m.at.x} cy={m.at.y} r={r} strokeWidth={3 * u} />
                  <text className="map-marker-glyph" x={m.at.x} y={m.at.y + (m.kind === 'turn' ? 5 : 6) * u} fontSize={(m.kind === 'turn' ? 14 : 18) * u}>{m.glyph}</text>
                  {m.label && (
                    <>
                      <rect className="map-marker-label-bg" x={lx} y={m.at.y - 15 * u} width={labelW} height={30 * u} rx={8 * u} strokeWidth={1.5 * u} />
                      <text className="map-marker-label" x={lx + 10 * u} y={m.at.y + 5.5 * u} fontSize={16 * u}>{m.label}</text>
                    </>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
        <span className="map-north" aria-hidden="true">N ↑</span>
        <div className="map-controls">
          <button type="button" className="map-control" onClick={() => zoom(0.7)} aria-label="Zoom in">+</button>
          <button type="button" className="map-control" onClick={() => zoom(1.4)} aria-label="Zoom out">−</button>
          <button type="button" className="map-control map-control-fit" onClick={() => setView(fitView())}>Fit</button>
        </div>
      </div>
      <figcaption className="map-caption">{caption}</figcaption>
    </figure>
  );
}
