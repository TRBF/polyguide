/** TTS-safe phrasing helpers (SPEC §4.5 step 6): no abbreviations, distances rounded to 5 m. */

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 10000) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred` + (n % 100 ? ` ${numberToWords(n % 100)}` : '');
  return `${numberToWords(Math.floor(n / 1000))} thousand` + (n % 1000 ? ` ${numberToWords(n % 1000)}` : '');
}

/** "30.5" → "thirty point five"; "07" stays digit-by-digit after the point. */
function numberText(s: string): string {
  const [int, frac] = s.split('.');
  const head = numberToWords(Number(int));
  return frac ? `${head} point ${frac.split('').map((d) => ONES[Number(d)]).join(' ')}` : head;
}

/** Letters spelled out so TTS doesn't read "HG" as a word: "HG" → "H G". */
const spell = (s: string) => s.split('').join(' ');

/** "HG F 30" → "room H G, F thirty"; withBuilding=false → "F thirty". */
export function speakRoom(name: string, withBuilding = true): string {
  const m = name.match(/^(\S+)\s+([A-Z]+)\s+(\d+(?:\.\d+)?)$/);
  if (!m) return name;
  const [, building, floor, num] = m;
  const short = `${spell(floor)} ${numberText(num)}`;
  return withBuilding ? `room ${spell(building)}, ${short}` : short;
}

/** "ETH.HG.EO" → "floor E O". */
export function speakFloor(levelId: string): string {
  return `floor ${spell(levelId.split('.').pop() ?? levelId)}`;
}

/** "ETH.HG.F" → "F". */
export const floorName = (levelId: string) => levelId.split('.').pop() ?? levelId;

/** Round to 5 m for speech, never below 5. */
export function speakMetres(m: number): string {
  const r = Math.max(5, Math.round(m / 5) * 5);
  return `about ${numberToWords(r)} metres`;
}

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
