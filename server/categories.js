// Generic landmark categories: spoken words (EN + FR) <-> OSM tags.
// Used when someone says "the church" / "l'église" without a proper name.

export const CATEGORIES = {
  church:      { words: ['church', 'cathedral', 'chapel', 'basilica', 'eglise', 'cathedrale', 'chapelle', 'basilique', 'temple'] },
  mosque:      { words: ['mosque', 'mosquee'] },
  synagogue:   { words: ['synagogue'] },
  school:      { words: ['school', 'college', 'lycee', 'ecole'] },
  university:  { words: ['university', 'universite', 'faculty', 'faculte', 'campus'] },
  hospital:    { words: ['hospital', 'clinic', 'hopital', 'clinique'] },
  pharmacy:    { words: ['pharmacy', 'chemist', 'pharmacie'] },
  police:      { words: ['police', 'commissariat', 'gendarmerie', 'precinct'] },
  fire_station:{ words: ['fire station', 'firehouse', 'caserne', 'pompiers'] },
  station:     { words: ['station', 'metro', 'subway', 'gare', 'train station', 'rer'] },
  park:        { words: ['park', 'garden', 'parc', 'jardin', 'square garden'] },
  square:      { words: ['square', 'plaza', 'place', 'piazza'] },
  bridge:      { words: ['bridge', 'pont', 'passerelle'] },
  museum:      { words: ['museum', 'musee', 'gallery'] },
  monument:    { words: ['monument', 'statue', 'memorial', 'column', 'colonne', 'obelisk'] },
  fountain:    { words: ['fountain', 'fontaine'] },
  cafe:        { words: ['cafe', 'coffee shop'] },
  restaurant:  { words: ['restaurant', 'bistro', 'brasserie'] },
  bar:         { words: ['bar', 'pub'] },
  bank:        { words: ['bank', 'banque', 'atm'] },
  hotel:       { words: ['hotel'] },
  parking:     { words: ['parking', 'car park', 'garage'] },
  fuel:        { words: ['gas station', 'petrol station', 'fuel station', 'station service'] },
  supermarket: { words: ['supermarket', 'grocery', 'supermarche', 'superette'] },
  bakery:      { words: ['bakery', 'boulangerie'] },
  post_office: { words: ['post office', 'la poste', 'poste'] },
  library:     { words: ['library', 'bibliotheque'] },
  townhall:    { words: ['town hall', 'city hall', 'mairie', 'hotel de ville'] },
  market:      { words: ['market', 'marche'] },
  theatre:     { words: ['theatre', 'theater'] },
  cinema:      { words: ['cinema', 'movie theater'] },
  cemetery:    { words: ['cemetery', 'cimetiere', 'graveyard'] },
  playground:  { words: ['playground', 'aire de jeux'] },
  street:      { words: ['street', 'road', 'avenue', 'boulevard', 'lane', 'rue', 'quai', 'allee', 'impasse', 'passage', 'way'] },
};

/** Derive our category from raw OSM tags. */
export function categoryFromTags(t = {}) {
  const b = t.building;
  if (t.amenity === 'place_of_worship' || ['church', 'cathedral', 'chapel', 'basilica'].includes(b)) {
    if (t.religion === 'muslim') return 'mosque';
    if (t.religion === 'jewish') return 'synagogue';
    return 'church';
  }
  const a = t.amenity;
  const direct = {
    school: 'school', college: 'school', university: 'university', hospital: 'hospital', clinic: 'hospital',
    pharmacy: 'pharmacy', police: 'police', fire_station: 'fire_station', cafe: 'cafe', restaurant: 'restaurant',
    fast_food: 'restaurant', bar: 'bar', pub: 'bar', bank: 'bank', parking: 'parking', fuel: 'fuel',
    post_office: 'post_office', library: 'library', townhall: 'townhall', marketplace: 'market',
    theatre: 'theatre', cinema: 'cinema', fountain: 'fountain', grave_yard: 'cemetery',
  };
  if (a && direct[a]) return direct[a];
  if (t.railway === 'station' || t.railway === 'subway_entrance' || t.public_transport === 'station') return 'station';
  if (t.leisure === 'park' || t.leisure === 'garden') return 'park';
  if (t.leisure === 'playground') return 'playground';
  if (t.place === 'square' || (t.highway === 'pedestrian' && t.area === 'yes')) return 'square';
  if (t.man_made === 'bridge' || (t.bridge && t.bridge !== 'no')) return 'bridge';
  if (t.tourism === 'museum' || t.tourism === 'gallery') return 'museum';
  if (t.tourism === 'hotel') return 'hotel';
  if (t.historic === 'monument' || t.historic === 'memorial' || t.memorial) return 'monument';
  if (t.landuse === 'cemetery') return 'cemetery';
  if (t.shop === 'supermarket' || t.shop === 'convenience') return 'supermarket';
  if (t.shop === 'bakery') return 'bakery';
  if (t.highway) return 'street';
  if (t.historic) return 'monument';
  if (t.tourism) return 'tourism';
  if (t.shop) return 'shop';
  return 'poi';
}

/** Map a free-text category word (from the LLM or the parser) to one of our keys. */
export function categoryFromWord(word) {
  if (!word) return null;
  const w = word.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (CATEGORIES[w]) return w;
  for (const [k, v] of Object.entries(CATEGORIES)) {
    if (v.words.some((x) => w === x || w.endsWith(' ' + x) || w.startsWith(x + ' '))) return k;
  }
  for (const [k, v] of Object.entries(CATEGORIES)) {
    if (v.words.some((x) => w.includes(x))) return k;
  }
  return null;
}

/** Words that describe the category rather than identify the place; ignored when fuzzy-matching names. */
export const GENERIC_WORDS = new Set(Object.values(CATEGORIES).flatMap((c) => c.words).filter((w) => !w.includes(' ')));
