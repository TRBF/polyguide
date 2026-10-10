/**
 * MOCK data for USE_MOCK=1 and for Track C before the server is up.
 * Coordinates are approximate positions inside HG and NOT real ETH network data.
 * Room names are placeholders; replace them with the real demo rooms from docs/DEMO.md.
 */
import type { Level, Place, RouteResult, VisionResult, LocalizeResult } from './types';

export const mockLevels: Level[] = [
  { id: 'ETH.HG.E', name: 'E', verticalOrder: 0, facility: 'HG' },
  { id: 'ETH.HG.F', name: 'F', verticalOrder: 1, facility: 'HG' },
];

export const mockPlaces: Place[] = [
  {
    id: 'pl_entrance_main', name: 'HG main entrance', kind: 'entrance', levelId: 'ETH.HG.E', verticalOrder: 0,
    lat: 47.37605, lon: 8.54795, nodeId: 'n1', aliases: ['main entrance', 'haupteingang hg'],
  },
  {
    id: 'pl_hg_e_41', name: 'HG E 41', kind: 'room', levelId: 'ETH.HG.E', verticalOrder: 0,
    lat: 47.37628, lon: 8.54772, nodeId: 'n3', useType: 'Hörsaal', aliases: ['hg e 41', 'e 41', 'e41', 'hge41'],
  },
  {
    id: 'pl_hg_f_30', name: 'HG F 30', label: 'Audimax', kind: 'room', levelId: 'ETH.HG.F', verticalOrder: 1,
    lat: 47.37652, lon: 8.54830, nodeId: 'n6', useType: 'Hörsaal', aliases: ['hg f 30', 'f 30', 'f30', 'hgf30', 'audimax'],
  },
  {
    id: 'pl_toilet_e', name: 'Accessible toilet (E)', kind: 'poi', levelId: 'ETH.HG.E', verticalOrder: 0,
    lat: 47.37620, lon: 8.54810, nodeId: 'n2', aliases: ['toilet', 'wc', 'accessible toilet'],
  },
];

export const mockRouteWheelchair: Extract<RouteResult, { ok: true }> = {
  ok: true,
  routeId: 'r_mock_wheelchair',
  from: mockPlaces[0],
  to: mockPlaces[2],
  profile: { needs: ['wheelchair'] },
  profileSummary: ['No stairs', 'Uses 1 elevator', 'Door widths unknown'],
  totalDistanceM: 96,
  totalDurationS: 150,
  levels: ['ETH.HG.E', 'ETH.HG.F'],
  warnings: ['Door widths are not in the ETH data.'],
  engine: 'own',
  steps: [
    {
      index: 0, maneuver: 'depart', text: 'Go straight 30 m into the main hall',
      speech: 'Go straight ahead for about 30 metres into the main hall.',
      distanceM: 30, durationS: 30, bearingDeg: 350, levelId: 'ETH.HG.E',
      startNodeId: 'n1', endNodeId: 'n2',
      polyline: [[8.54795, 47.37605], [8.54788, 47.37632]],
      expectedLandmarks: [{ label: 'HG E 41', kind: 'room_sign', side: 'left', atDistanceM: 22, placeId: 'pl_hg_e_41' }],
      edgeKinds: ['entrance', 'hallway'],
    },
    {
      index: 1, maneuver: 'right', text: 'Turn right, then go 24 m to the elevator',
      speech: 'Turn right. Then go about 25 metres to the elevator.',
      distanceM: 24, durationS: 24, bearingDeg: 75, levelId: 'ETH.HG.E',
      startNodeId: 'n2', endNodeId: 'n4',
      polyline: [[8.54788, 47.37632], [8.54819, 47.37638]],
      expectedLandmarks: [{ label: 'elevator', kind: 'elevator', side: 'ahead', atDistanceM: 24 }],
      edgeKinds: ['hallway'],
    },
    {
      index: 2, maneuver: 'take_elevator', text: 'Take the elevator to floor F',
      speech: 'Take the elevator up to floor F. Say "done" when you are out of the elevator.',
      distanceM: 4, durationS: 31, bearingDeg: null, levelId: 'ETH.HG.E', toLevelId: 'ETH.HG.F',
      startNodeId: 'n4', endNodeId: 'n5',
      polyline: [[8.54819, 47.37638], [8.54819, 47.37638]],
      expectedLandmarks: [{ label: 'floor F', kind: 'other', side: 'ahead', atDistanceM: 0 }],
      edgeKinds: ['elevator'],
    },
    {
      index: 3, maneuver: 'left', text: 'Turn left, go 38 m',
      speech: 'Turn left. Then go about 40 metres along the corridor.',
      distanceM: 38, durationS: 38, bearingDeg: 20, levelId: 'ETH.HG.F',
      startNodeId: 'n5', endNodeId: 'n6',
      polyline: [[8.54819, 47.37638], [8.54830, 47.37652]],
      expectedLandmarks: [{ label: 'HG F 33', kind: 'room_sign', side: 'right', atDistanceM: 20 }],
      edgeKinds: ['hallway'],
    },
    {
      index: 4, maneuver: 'arrive', text: 'Arrived: HG F 30 (Audimax) is on your right',
      speech: 'You have arrived. Room H G, F thirty, the Audimax, is on your right.',
      distanceM: 0, durationS: 0, bearingDeg: null, levelId: 'ETH.HG.F', side: 'right',
      startNodeId: 'n6', endNodeId: 'n6',
      polyline: [[8.54830, 47.37652], [8.54830, 47.37652]],
      expectedLandmarks: [{ label: 'HG F 30', kind: 'room_sign', side: 'right', atDistanceM: 0, placeId: 'pl_hg_f_30' }],
      edgeKinds: [],
    },
  ],
};

export const mockVisionResult: VisionResult = {
  sceneSummary: 'A corridor with doors on both sides; a room sign on the left.',
  readText: ['HG E 41', 'Hörsaal'],
  detectedRoomNames: ['HG E 41'],
  seen: [{ label: 'HG E 41', matchesExpected: true, relativeDirection: 'left' }],
  atExpectedPoint: true,
  offRouteSuspected: false,
  notableThings: ['open double door ahead'],
  utterance: 'Room E 41 is on your left. Keep going straight.',
  confidence: 0.82,
  latencyMs: 1800,
};

export const mockLocalize: LocalizeResult = {
  ok: true,
  place: mockPlaces[1],
  nodeId: 'n3',
  levelId: 'ETH.HG.E',
  confidence: 0.9,
  method: 'room_text',
  alternatives: [],
};
