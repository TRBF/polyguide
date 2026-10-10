import { useEffect, useMemo, useRef, useState } from 'react';
import type { RouteResult } from '@polyguide/shared';
import { api, type FloorMap } from './api';

type Route = Extract<RouteResult, { ok: true }>;
type Position = [number, number];
interface MapGeometry {
  type: string;
  coordinates: unknown;
}
interface MapFeature {
  id?: string | number;
  geometry?: MapGeometry | null;
  properties?: Record<string, unknown>;
}
interface ProjectedPoint {
  x: number;
  y: number;
}

// Drawing units ≈ CSS px on a phone (the SVG renders ~350–600 px wide), so marker text stays legible.
const viewWidth = 600;
const viewHeight = 400;
const padding = 40;
/** Metres of context shown around the route. */
const ROUTE_MARGIN_M = 25;

function isPosition(value: unknown): value is Position {
  return Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number';
}

function gatherPositions(value: unknown, points: Position[] = []): Position[] {
  if (isPosition(value)) points.push([value[0], value[1]]);
  else if (Array.isArray(value)) value.forEach((item) => gatherPositions(item, points));
  return points;
}

function coordinates(value: unknown): Position[] {
  return Array.isArray(value) ? value.filter(isPosition).map((point) => [point[0], point[1]]) : [];
}

function polygonRings(value: unknown): Position[][] {
  if (!Array.isArray(value)) return [];
  return value.filter(Array.isArray).map((ring) => coordinates(ring));
}

function mapLabel(feature: MapFeature): string {
  const candidate = feature.properties?.name;
  return typeof candidate === 'string' ? candidate : '';
}

function mapFeature(feature: MapFeature, project: (position: Position) => ProjectedPoint, key: string, destinationId: string) {
  const geometry = feature.geometry;
  if (!geometry) return null;
  // Other places stay quiet (small unlabelled dots); only the route's own points get labels.
  if (geometry.type === 'Point' && isPosition(geometry.coordinates)) {
    const point = project(geometry.coordinates);
    return <circle key={key} className="map-place-dot" cx={point.x} cy={point.y} r="5"><title>{mapLabel(feature) || 'Place on this floor'}</title></circle>;
  }
  const roomClass = feature.properties?.placeId === destinationId ? 'map-room map-room-destination' : 'map-room';
  if (geometry.type === 'LineString') {
    const points = coordinates(geometry.coordinates).map(project);
    if (points.length < 2) return null;
    return <polyline key={key} className="map-pathway" points={points.map((point) => `${point.x},${point.y}`).join(' ')} />;
  }
  if (geometry.type === 'MultiLineString' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.map((line, index) => {
      const points = coordinates(line).map(project);
      return points.length > 1 ? <polyline key={`${key}-${index}`} className="map-pathway" points={points.map((point) => `${point.x},${point.y}`).join(' ')} /> : null;
    });
  }
  if (geometry.type === 'Polygon') {
    const [outer] = polygonRings(geometry.coordinates);
    const points = outer?.map(project) ?? [];
    return points.length > 2 ? <polygon key={key} className={roomClass} points={points.map((point) => `${point.x},${point.y}`).join(' ')}><title>{mapLabel(feature) || 'Room outline'}</title></polygon> : null;
  }
  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.map((polygon, index) => {
      const [outer] = polygonRings(polygon);
      const points = outer?.map(project) ?? [];
      return points.length > 2 ? <polygon key={`${key}-${index}`} className={roomClass} points={points.map((point) => `${point.x},${point.y}`).join(' ')}><title>{mapLabel(feature) || 'Room outline'}</title></polygon> : null;
    });
  }
  return null;
}

interface Marker {
  at: Position;
  kind: 'start' | 'end' | 'transfer';
  glyph: string;
  label: string;
}

const floorOf = (levelId: string) => levelId.split('.').at(-1) ?? levelId;

/** Where the route starts, ends, and changes floor — the only labelled points on the map. */
function routeMarkers(route: Route, levelId: string): Marker[] {
  const markers: Marker[] = [];
  const first = route.steps[0];
  if (first?.levelId === levelId && first.polyline[0]) markers.push({ at: first.polyline[0], kind: 'start', glyph: 'S', label: 'Start' });
  for (const step of route.steps) {
    if (!step.toLevelId || step.toLevelId === step.levelId) continue;
    const what = step.maneuver === 'take_elevator' ? 'Elevator' : step.maneuver.startsWith('take_ramp') ? 'Ramp' : 'Stairs';
    if (step.levelId === levelId && step.polyline[0]) markers.push({ at: step.polyline[0], kind: 'transfer', glyph: '↕', label: `${what} to floor ${floorOf(step.toLevelId)}` });
    const exit = step.polyline.at(-1);
    if (step.toLevelId === levelId && exit) markers.push({ at: exit, kind: 'transfer', glyph: '↕', label: `${what} from floor ${floorOf(step.levelId)}` });
  }
  const last = route.steps.at(-1);
  if (last?.maneuver === 'arrive' && last.levelId === levelId && last.polyline[0]) markers.push({ at: last.polyline[0], kind: 'end', glyph: '●', label: route.to.label ?? route.to.name });
  return markers;
}

/** Rough label width in viewBox units (no DOM measuring needed). */
const labelWidth = (text: string) => text.length * 13 + 24;

export function RouteMap({ route, levelId }: { route: Route; levelId: string }) {
  const [floorMap, setFloorMap] = useState<FloorMap | null>(null);
  const [mapError, setMapError] = useState(false);

  // Keep a response only if it is for the floor still selected. (A per-effect "active" flag lost
  // the first load: the cleanup ran before the single in-flight request resolved.)
  const currentLevel = useRef(levelId);
  currentLevel.current = levelId;
  useEffect(() => {
    setMapError(false);
    setFloorMap(null);
    api.floorMap(levelId)
      .then((data) => { if (currentLevel.current === levelId) setFloorMap(data); })
      .catch(() => { if (currentLevel.current === levelId) { setFloorMap(null); setMapError(true); } });
  }, [levelId]);

  const routeLines: Position[][] = route.steps
    .filter((step) => step.levelId === levelId && step.polyline.length > 1)
    .map((step) => step.polyline.map(([lon, lat]) => [lon, lat]));
  const features = (floorMap?.features ?? []) as MapFeature[];
  // Frame the route (plus a margin) when this floor has one; otherwise the whole floor.
  const allPositions = useMemo(() => {
    const routePoints = routeLines.flat();
    if (routePoints.length) {
      const lat0 = routePoints[0][1];
      const dLat = ROUTE_MARGIN_M / 110540;
      const dLon = ROUTE_MARGIN_M / (111320 * Math.cos((lat0 * Math.PI) / 180));
      return routePoints.flatMap(([lon, lat]) => [[lon - dLon, lat - dLat], [lon + dLon, lat + dLat]] as Position[]);
    }
    return features.flatMap((feature) => gatherPositions(feature.geometry?.coordinates));
  }, [features, routeLines]);
  if (!allPositions.length) allPositions.push([route.to.lon, route.to.lat]);

  const referenceLatitude = allPositions.reduce((sum, point) => sum + point[1], 0) / allPositions.length;
  const longitudeScale = Math.cos((referenceLatitude * Math.PI) / 180) * 111320;
  const meterPoints = allPositions.map(([lon, lat]) => ({ x: lon * longitudeScale, y: lat * 110540 }));
  const minX = Math.min(...meterPoints.map((point) => point.x));
  const maxX = Math.max(...meterPoints.map((point) => point.x));
  const minY = Math.min(...meterPoints.map((point) => point.y));
  const maxY = Math.max(...meterPoints.map((point) => point.y));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const scale = Math.min((viewWidth - padding * 2) / width, (viewHeight - padding * 2) / height);
  const xOffset = (viewWidth - width * scale) / 2;
  const yOffset = (viewHeight - height * scale) / 2;
  const project = (position: Position): ProjectedPoint => ({
    x: xOffset + (position[0] * longitudeScale - minX) * scale,
    y: viewHeight - yOffset - (position[1] * 110540 - minY) * scale,
  });

  const markers = routeMarkers(route, levelId);
  const floor = floorOf(levelId);
  const caption = routeLines.length
    ? `Floor ${floor}. The blue line is your route${markers.length ? `; marked: ${markers.map((m) => m.label).join(', ')}` : ''}. The written steps below give the full route.`
    : `Floor ${floor}. Your route does not walk on this floor.`;

  return (
    <figure className="map-figure">
      {mapError && <p className="map-note">Floor drawing is unavailable. The written route steps are still available below.</p>}
      <svg className="route-map" viewBox={`0 0 ${viewWidth} ${viewHeight}`} role="img" aria-label={caption}>
        <rect className="map-background" x="0" y="0" width={viewWidth} height={viewHeight} />
        <clipPath id="map-clip"><rect x="0" y="0" width={viewWidth} height={viewHeight} /></clipPath>
        <g clipPath="url(#map-clip)">{features.map((feature, index) => mapFeature(feature, project, String(feature.id ?? index), route.to.id))}</g>
        {routeLines.map((line, index) => {
          const points = line.map(project).map((point) => `${point.x},${point.y}`).join(' ');
          return <g key={`route-${index}`}><polyline className="map-route-outline" points={points} /><polyline className="map-route-line" points={points} /></g>;
        })}
        {markers.map((marker, index) => {
          const point = project(marker.at);
          const width = labelWidth(marker.label);
          // Keep labels inside the frame: flip to the left near the right edge.
          const left = point.x + 28 + width > viewWidth;
          const x = left ? point.x - 28 - width : point.x + 28;
          return (
            <g key={`marker-${index}`} className={`map-marker map-marker-${marker.kind}`}>
              <circle cx={point.x} cy={point.y} r="20" />
              <text className="map-marker-glyph" x={point.x} y={point.y + 8}>{marker.glyph}</text>
              <rect className="map-marker-label-bg" x={x} y={point.y - 20} width={width} height="40" rx="10" />
              <text className="map-marker-label" x={x + 12} y={point.y + 8}>{marker.label}</text>
            </g>
          );
        })}
      </svg>
      <figcaption className="map-caption">{caption}</figcaption>
    </figure>
  );
}
