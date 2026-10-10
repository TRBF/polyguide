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

const viewWidth = 1000;
const viewHeight = 600;
const padding = 48;
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

function mapFeature(feature: MapFeature, project: (position: Position) => ProjectedPoint, key: string) {
  const geometry = feature.geometry;
  if (!geometry) return null;
  if (geometry.type === 'Point' && isPosition(geometry.coordinates)) {
    const point = project(geometry.coordinates);
    const label = mapLabel(feature);
    return <g key={key}><circle className="map-place-dot" cx={point.x} cy={point.y} r="6" /><title>{label || 'Place on this floor'}</title>{label && <text className="map-place-label" x={point.x + 9} y={point.y - 8}>{label}</text>}</g>;
  }
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
    return points.length > 2 ? <polygon key={key} className="map-room" points={points.map((point) => `${point.x},${point.y}`).join(' ')}><title>{mapLabel(feature) || 'Room outline'}</title></polygon> : null;
  }
  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.map((polygon, index) => {
      const [outer] = polygonRings(polygon);
      const points = outer?.map(project) ?? [];
      return points.length > 2 ? <polygon key={`${key}-${index}`} className="map-room" points={points.map((point) => `${point.x},${point.y}`).join(' ')}><title>{mapLabel(feature) || 'Room outline'}</title></polygon> : null;
    });
  }
  return null;
}

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

  return (
    <figure className="map-figure">
      {mapError && <p className="map-note">Floor drawing is unavailable. The written route steps are still available below.</p>}
      <svg className="route-map" viewBox={`0 0 ${viewWidth} ${viewHeight}`} role="img" aria-label={`Indoor map for floor ${levelId.split('.').at(-1) ?? levelId}. Route is highlighted with a thick line.`}>
        <rect className="map-background" x="0" y="0" width={viewWidth} height={viewHeight} />
        <clipPath id="map-clip"><rect x="0" y="0" width={viewWidth} height={viewHeight} /></clipPath>
        <g clipPath="url(#map-clip)">{features.map((feature, index) => mapFeature(feature, project, String(feature.id ?? index)))}</g>
        {routeLines.map((line, index) => {
          const points = line.map(project).map((point) => `${point.x},${point.y}`).join(' ');
          return <g key={`route-${index}`}><polyline className="map-route-outline" points={points} /><polyline className="map-route-line" points={points} /></g>;
        })}
      </svg>
      <figcaption className="map-caption">Floor {levelId.split('.').at(-1) ?? levelId}. The written steps below provide the full route without relying on the map.</figcaption>
    </figure>
  );
}
