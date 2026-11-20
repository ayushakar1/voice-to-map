// Event store: every report is an immutable-ish event; unit state is derived from the log.
// Persisted to data/events.json so a restart keeps the history (and replay still works).
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const FILE = path.join(config.dataDir, "events.json");
const PALETTE = [
  "#e6194b",
  "#3cb44b",
  "#4363d8",
  "#f58231",
  "#911eb4",
  "#008080",
  "#f032e6",
  "#9a6324",
  "#800000",
  "#000075",
];

class Store {
  constructor() {
    this.events = [];
    this.colors = {};
    try {
      if (fs.existsSync(FILE))
        this.events = JSON.parse(fs.readFileSync(FILE, "utf8"));
    } catch (e) {
      console.warn("[store] could not read events:", e.message);
    }
    for (const e of this.events) this.colorFor(e.unit);
  }

  colorFor(unit) {
    if (!this.colors[unit])
      this.colors[unit] =
        PALETTE[Object.keys(this.colors).length % PALETTE.length];
    return this.colors[unit];
  }

  persist() {
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(FILE + ".tmp", JSON.stringify(this.events));
      fs.renameSync(FILE + ".tmp", FILE);
    }, 200);
  }

  /**
   * Insert the event in timestamp order (not completion order), so lastPosition() and the
   * history always reflect when things were spoken. Equal timestamps keep arrival order.
   */
  add(event) {
    event.color = this.colorFor(event.unit);

    // Walk back from the end until we find the last event that is not newer than this one.
    let index = this.events.length;
    while (index > 0 && this.events[index - 1].ts > event.ts) index--;

    this.events.splice(index, 0, event);
    this.persist();
    return event;
  }

  get(id) {
    return this.events.find((e) => e.id === id);
  }

  update(id, patch) {
    const e = this.get(id);
    if (!e) return null;
    Object.assign(e, patch);
    this.persist();
    return e;
  }

  /** Last located position of a unit (optionally before a given event). */
  lastPosition(unit, beforeTs = Infinity) {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.unit === unit && e.ts < beforeTs && e.position)
        return { ...e.position, ts: e.ts, label: e.result?.explanation };
    }
    return null;
  }

  units() {
    const u = {};
    for (const e of this.events)
      u[e.unit] = {
        unit: e.unit,
        color: this.colorFor(e.unit),
        last: this.lastPosition(e.unit),
      };
    return Object.values(u);
  }

  reset() {
    this.events = [];
    this.colors = {};
    this.persist();
  }
}

export const store = new Store();
