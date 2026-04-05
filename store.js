const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const BASELINES_FILE = path.join(DATA_DIR, 'baselines.json');
const DIGESTS_FILE = path.join(DATA_DIR, 'digests.json');
const MAX_EVENTS = 2000;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Events ────────────────────────────────────────────────────────────────────
// Each event: { id, ts, source, type, value, unit, lat, lon, meta, anomaly }
// source = 'ADSB' | 'AIS' | 'SEISMIC' | 'FIRMS' | 'OIL' | 'BGP' | 'NOTAM' | 'TENDER' | 'OFFICIAL'
// anomaly = null | { score: 0-100, reason: string }

function getEvents(opts = {}) {
  const events = readJSON(EVENTS_FILE, []);
  let result = events;
  if (opts.source) result = result.filter(e => e.source === opts.source);
  if (opts.since) result = result.filter(e => e.ts >= opts.since);
  if (opts.anomalyOnly) result = result.filter(e => e.anomaly);
  if (opts.limit) result = result.slice(-opts.limit);
  return result;
}

function addEvents(newEvents) {
  let events = readJSON(EVENTS_FILE, []);
  const existingIds = new Set(events.map(e => e.id));
  const toAdd = newEvents.filter(e => !existingIds.has(e.id));
  events = [...events, ...toAdd];
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  writeJSON(EVENTS_FILE, events);
  return toAdd.length;
}

// ── Baselines ─────────────────────────────────────────────────────────────────
// Rolling 7-day averages per source/type used for anomaly detection

function getBaseline(source, type) {
  const baselines = readJSON(BASELINES_FILE, {});
  return baselines[`${source}:${type}`] || null;
}

function updateBaseline(source, type, value) {
  const baselines = readJSON(BASELINES_FILE, {});
  const key = `${source}:${type}`;
  const b = baselines[key] || { values: [], mean: value, stddev: 0 };
  b.values = [...b.values, value].slice(-168); // 168 samples = 7 days at hourly
  b.mean = b.values.reduce((a, v) => a + v, 0) / b.values.length;
  const variance = b.values.reduce((a, v) => a + Math.pow(v - b.mean, 2), 0) / b.values.length;
  b.stddev = Math.sqrt(variance);
  b.updatedAt = Date.now();
  baselines[key] = b;
  writeJSON(BASELINES_FILE, baselines);
  return b;
}

function isAnomaly(source, type, value) {
  const b = getBaseline(source, type);
  if (!b || b.values.length < 12) return null; // need at least 12 samples
  const zScore = b.stddev > 0 ? Math.abs(value - b.mean) / b.stddev : 0;
  if (zScore < 2) return null; // within 2 standard deviations = normal
  const score = Math.min(100, Math.round(zScore * 25));
  return { score, zScore: +zScore.toFixed(2), mean: +b.mean.toFixed(2), stddev: +b.stddev.toFixed(2) };
}

// ── Digests ───────────────────────────────────────────────────────────────────
function getLatestDigest() {
  const digests = readJSON(DIGESTS_FILE, []);
  return digests[digests.length - 1] || null;
}

function saveDigest(digest) {
  const digests = readJSON(DIGESTS_FILE, []);
  digests.push({ ...digest, ts: Date.now() });
  if (digests.length > 48) digests.splice(0, digests.length - 48);
  writeJSON(DIGESTS_FILE, digests);
}

module.exports = { getEvents, addEvents, getBaseline, updateBaseline, isAnomaly, getLatestDigest, saveDigest };
