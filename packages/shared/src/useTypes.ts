/** ETH room types (German, from PolyMaps) in plain English for display and speech. Unknown types pass through. */
export const USE_TYPES: Record<string, string> = {
  'Büro': 'Office',
  'Aufzug': 'Elevator',
  'WC Herren': "Men's toilet",
  'WC Damen': "Women's toilet",
  'WC': 'Toilet',
  'WC Geschlechtsneutral': 'All-gender toilet',
  'WC Geschlechtsneutral Barrierefrei': 'Accessible all-gender toilet',
  'WC und Dusche Geschlechtsneutral': 'All-gender toilet and shower',
  'Sitzungszimmer': 'Meeting room',
  'Bibliothek': 'Library',
  'Seminarraum': 'Seminar room',
  'Hörsaal': 'Lecture hall',
  'Garderobe': 'Cloakroom',
  'Garderobe Herren': "Men's cloakroom",
  'Garderobe Geschlechtsneutral': 'All-gender cloakroom',
  'Verpflegung': 'Food and drink',
  'Drucken und Kopieren': 'Printing and copying',
  'Eingang und Ausgang': 'Entrance and exit',
  'Aufenthaltsraum': 'Common room',
  'Computerraum': 'Computer room',
  'Rückzugsraum': 'Quiet room',
  'Mehrzweckraum': 'Multipurpose room',
  'Sicherheitsraum': 'Safety room',
  'Parkplatz': 'Parking',
  'Meetingbox': 'Meeting booth',
  'Ausstellung': 'Exhibition',
  'Werkstatt': 'Workshop',
  'Information': 'Information',
  'Arbeitsplatz': 'Workspace',
  'Einkauf': 'Shop',
  'Labor': 'Laboratory',
  'Sonstiges': 'Other',
};

export const useTypeLabel = (useType: string | undefined): string | undefined => (useType ? USE_TYPES[useType] ?? useType : undefined);

/** "seminar room", "a lecture hall", "the library" → the German ETH type it names, or undefined. */
export function useTypeFromText(text: string): string | undefined {
  const t = text.trim().toLowerCase().replace(/^(a|an|the|any|nearest|closest)\s+/, '').replace(/s$/, '');
  return Object.keys(USE_TYPES).find((de) => USE_TYPES[de].toLowerCase() === t || de.toLowerCase() === t);
}
