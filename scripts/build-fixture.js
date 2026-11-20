// Converts test/fixtures/synthetic-osm.json (Overpass format) into a gazetteer feature file.
import fs from 'node:fs';
import { buildFeatures } from '../server/gazetteer.js';
const osm = JSON.parse(fs.readFileSync(new URL('../test/fixtures/synthetic-osm.json', import.meta.url)));
const out = new URL('../test/fixtures/synthetic-gazetteer.json', import.meta.url);
fs.writeFileSync(out, JSON.stringify(buildFeatures(osm), null, 1));
console.log('wrote', out.pathname);
