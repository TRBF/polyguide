import { describe, expect, it } from 'vitest';
import { chooseCandidates, lookAlike, photoRooms, scoreConfidence } from './locateRoom';

describe('scoreConfidence', () => {
  it('is zero below the minimum score', () => {
    expect(scoreConfidence(45, 0)).toBe(0);
  });
  it('keeps the full score with a clear gap and shrinks it when the runner-up is close', () => {
    expect(scoreConfidence(90, 40)).toBe(0.9);
    expect(scoreConfidence(90, 80)).toBe(0.36);
    expect(scoreConfidence(90, 90)).toBe(0);
  });
});

describe('lookAlike', () => {
  const room = { type: 'Lecture hall', seating: 'fixed', floorShape: 'graded', heightM: 4.5, floorAreaM2: 165 };
  it('pairs rooms built the same way (HG D 1.1 / D 1.2)', () => {
    expect(lookAlike(room, { ...room, floorAreaM2: 163.6 })).toBe(true);
  });
  it('separates rooms of another type, size or height', () => {
    expect(lookAlike(room, { ...room, type: 'Seminars / Courses' })).toBe(false);
    expect(lookAlike(room, { ...room, floorAreaM2: 250 })).toBe(false);
    expect(lookAlike(room, { ...room, heightM: 6.1 })).toBe(false);
  });
});

describe('photo rooms (data/hg/room-photos)', () => {
  it('places every room with photos on the map', () => {
    const rooms = photoRooms();
    expect(rooms.length).toBe(71);
    expect(rooms.every((r) => r.levelId.startsWith('ETH.HG.') && Number.isFinite(r.lat) && r.photos.length > 0)).toBe(true);
    // Foyer exhibition spaces are not routing places: they are placed by their floor-plan unit.
    expect(rooms.find((r) => r.name === 'HG E 30.0015')?.placeName).toMatch(/^HG E/);
  });

  it('chooses candidates by type and floor, nearest first, or the names given', () => {
    const f = chooseCandidates({ levelId: 'ETH.HG.F', roomType: 'Lecture hall' });
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((r) => r.levelId === 'ETH.HG.F' && r.type === 'Lecture hall')).toBe(true);
    expect(f.some((r) => r.name === 'HG F 30')).toBe(true);
    expect(chooseCandidates({ candidates: ['E 1.1', 'HG E 1.2'] }).map((r) => r.name).sort()).toEqual(['HG E 1.1', 'HG E 1.2']);
  });
});
