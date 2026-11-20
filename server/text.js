// Text normalisation + fuzzy matching helpers shared by gazetteer and parser.

const ONES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16,
  seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50,
  sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90 };

function ordSuffix(n) {
  const s = n % 100;
  if (s >= 11 && s <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] ?? 'th'}`;
}

/** "thirty fifth" -> "35th", "thirty-five" -> "35", "35 th" -> "35th" */
export function wordsToNumbers(s) {
  let t = s.replace(/-/g, ' ');
  t = t.replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)\b/g,
    (_, a, b) => ordSuffix(TENS[a] + ORD[b]));
  t = t.replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(one|two|three|four|five|six|seven|eight|nine)\b/g,
    (_, a, b) => String(TENS[a] + ONES[b]));
  t = t.replace(/\b([a-z]+)\b/g, (w) => (ORD[w] ? ordSuffix(ORD[w]) : ONES[w] !== undefined ? String(ONES[w]) : TENS[w] ? String(TENS[w]) : w));
  t = t.replace(/\b(\d+)\s*(st|nd|rd|th)\b/g, '$1$2');
  return t;
}

const ABBREV = {
  ave: 'avenue', av: 'avenue', bd: 'boulevard', blvd: 'boulevard', rd: 'road', sq: 'square', pl: 'place',
  ste: 'sainte', mt: 'mount', dr: 'drive', ln: 'lane', hwy: 'highway', fbg: 'faubourg',
};

const STOP = new Set(['the', 'a', 'an', 'of', 'de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'et', 'and', 'to', 'on', 'at']);

export function normalize(s) {
  if (!s) return '';
  let t = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  t = t.replace(/[’'`]/g, ' ').replace(/[^a-z0-9\s]/g, ' ');
  t = wordsToNumbers(t);
  // "st" is ambiguous: "st paul" = saint, "35th st" = street
  t = t.replace(/\bst\b(?=\s+(?!and\b|et\b|or\b)[a-z])/g, 'saint').replace(/\bst\b/g, 'street');
  t = t.replace(/\b([a-z]+)\b/g, (w) => ABBREV[w] ?? w);
  // Numbered streets: "35 street" -> "35th street"
  t = t.replace(/\b(\d+)\s+(street|avenue)\b/g, (_, n, w) => `${ordSuffix(Number(n))} ${w}`);
  return t.replace(/\s+/g, ' ').trim();
}

export function tokens(s) {
  return normalize(s).split(' ').filter((w) => w && !STOP.has(w));
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function tokenEq(a, b) {
  if (a === b) return 1;
  if (/\d/.test(a) || /\d/.test(b)) return 0; // numbers must match exactly
  const L = Math.max(a.length, b.length);
  if (L < 4) return 0;
  const d = levenshtein(a, b);
  if (d === 1) return 0.85;
  if (d === 2 && L >= 7) return 0.7;
  if (L >= 5 && (a.startsWith(b) || b.startsWith(a))) return 0.6;
  return 0;
}

/**
 * Similarity of a spoken query vs a gazetteer name, 0..1.
 * Asymmetric: rewards covering the query's tokens; mild penalty for extra name tokens.
 */
export function nameSimilarity(query, name, ignore = new Set()) {
  const q = tokens(query).filter((t) => !ignore.has(t));
  const n = tokens(name).filter((t) => !ignore.has(t));
  if (!q.length || !n.length) return 0;
  // A shared word such as "street" must never match a different street number.
  if (q.some((token) => /\d/.test(token) && !n.includes(token))) return 0;
  let hit = 0;
  for (const qt of q) {
    let best = 0;
    for (const nt of n) best = Math.max(best, tokenEq(qt, nt));
    hit += best;
  }
  const recall = hit / q.length;
  const precision = hit / n.length;
  let score = 0.75 * recall + 0.25 * precision;
  const nq = q.join(' '), nn = n.join(' ');
  if (nq === nn) score = 1;
  else if (nn.includes(nq) && nq.length >= 4) score = Math.max(score, 0.9);
  return Math.min(1, score);
}
