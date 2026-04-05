const fetch = require('node-fetch');
const { updateBaseline, isAnomaly } = require('./store');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function safeFetch(url, opts = {}, timeout = 10000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
    clearTimeout(t);
    return res;
  } catch (e) { clearTimeout(t); throw e; }
}

// ── 1. SEISMIC — USGS Earthquake API ─────────────────────────────────────────
// Covers: underground nuclear tests (look for Mb > 4.5, depth < 5km, no aftershocks)
// Target zones: Pakistan (Balochistan), North Korea, Iran, India
async function collectSeismic() {
  const events = [];
  try {
    // Last 24h, magnitude >= 3.0, region of interest bounding box
    // Covers South Asia, Middle East, East Asia
    const url = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minmagnitude=3.5&orderby=time&limit=50&minlatitude=10&maxlatitude=45&minlongitude=44&maxlongitude=135&starttime=' + new Date(Date.now() - 86400000).toISOString();
    const res = await safeFetch(url);
    const data = await res.json();
    for (const f of (data.features || [])) {
      const p = f.properties;
      const [lon, lat, depth] = f.geometry.coordinates;
      const mag = p.mag;
      const id = `SEISMIC:${f.id}`;
      // Anomaly flag: shallow depth (<10km) + significant magnitude = possible explosion
      const suspiciousTest = depth < 10 && mag >= 4.5;
      events.push({
        id,
        ts: p.time,
        source: 'SEISMIC',
        type: 'earthquake',
        value: mag,
        unit: 'Mb',
        lat, lon,
        meta: {
          place: p.place,
          depth: Math.round(depth),
          mag,
          type: p.type,
          url: p.url,
        },
        anomaly: suspiciousTest ? {
          score: Math.min(100, Math.round(mag * 15)),
          reason: `Shallow depth ${Math.round(depth)}km + Mb${mag} — possible subsurface explosion signature`,
        } : null,
      });
    }
  } catch (e) { console.error('[SEISMIC] Error:', e.message); }
  return events;
}

// ── 2. FIRMS — NASA Fire/Thermal Anomaly ──────────────────────────────────────
// Covers: airstrikes show as thermal hotspots, military activity, fuel depot fires
// Uses public CSV endpoint — no key needed for 24h data
async function collectFIRMS() {
  const events = [];
  try {
    // VIIRS SNPP 24h data — South Asia + Middle East bounding box
    // Public endpoint, no API key
    const url = 'https://firms.modaps.eosdis.nasa.gov/api/country/csv/6a0ce8e21c5ca1f9de9bb2a8b6ffc7d1/VIIRS_SNPP_NRT/IND,PAK,IRN,IRQ,SAU,ARE,OMN,YEM,AFG,CHN/1';
    const res = await safeFetch(url);
    const text = await res.text();
    const lines = text.trim().split('\n').slice(1); // skip header
    const byDay = {};
    for (const line of lines) {
      const [country, lat, lon, brightness, scan, track, acq_date, acq_time, satellite, instrument, confidence, version, bright_t31, frp, daynight] = line.split(',');
      if (!lat || isNaN(parseFloat(frp))) continue;
      const frpVal = parseFloat(frp);
      if (frpVal < 50) continue; // filter low-energy fires (cooking fires etc)
      const key = `${parseFloat(lat).toFixed(1)},${parseFloat(lon).toFixed(1)}`;
      if (!byDay[key]) byDay[key] = { lat: parseFloat(lat), lon: parseFloat(lon), frp: frpVal, country, count: 1, acq_date, acq_time };
      else { byDay[key].frp = Math.max(byDay[key].frp, frpVal); byDay[key].count++; }
    }
    for (const [key, f] of Object.entries(byDay)) {
      if (f.frp < 100) continue; // only significant thermal events
      const id = `FIRMS:${key}:${f.acq_date}`;
      const baseline = updateBaseline('FIRMS', f.country, f.frp);
      const anomaly = isAnomaly('FIRMS', f.country, f.frp);
      events.push({
        id,
        ts: new Date(`${f.acq_date}T${f.acq_time?.slice(0,2)||'12'}:00:00Z`).getTime(),
        source: 'FIRMS',
        type: 'thermal_anomaly',
        value: Math.round(f.frp),
        unit: 'MW (Fire Radiative Power)',
        lat: f.lat, lon: f.lon,
        meta: { country: f.country, frp: f.frp, count: f.count, date: f.acq_date },
        anomaly: f.frp > 500 ? { score: Math.min(100, Math.round(f.frp / 10)), reason: `High-energy thermal event ${Math.round(f.frp)}MW — possible fuel depot, ammunition, or airstrike` } : anomaly,
      });
    }
  } catch (e) { console.error('[FIRMS] Error:', e.message); }
  return events;
}

// ── 3. OIL PRICES — Yahoo Finance (no key needed) ────────────────────────────
// Covers: Brent crude as conflict barometer — sharp spikes = market pricing war risk
async function collectOilPrice() {
  const events = [];
  try {
    const symbols = [
      { sym: 'BZ=F', label: 'Brent Crude', region: 'Gulf/Global' },
      { sym: 'CL=F', label: 'WTI Crude', region: 'Americas' },
    ];
    for (const { sym, label, region } of symbols) {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1h&range=48h`;
      const res = await safeFetch(url, { headers: { 'Accept': 'application/json' } });
      const data = await res.json();
      const result = data.chart?.result?.[0];
      if (!result) continue;
      const prices = result.indicators.quote[0].close.filter(Boolean);
      const timestamps = result.timestamp;
      if (!prices.length) continue;
      const latest = prices[prices.length - 1];
      const prev24h = prices[0];
      const changePct = ((latest - prev24h) / prev24h) * 100;
      updateBaseline('OIL', sym, latest);
      const anomaly = Math.abs(changePct) >= 3 ? {
        score: Math.min(100, Math.round(Math.abs(changePct) * 10)),
        reason: `${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}% move in 48h — market pricing ${changePct > 0 ? 'elevated' : 'reduced'} supply risk`,
      } : isAnomaly('OIL', sym, latest);
      events.push({
        id: `OIL:${sym}:${Math.floor(Date.now() / 3600000)}`,
        ts: Date.now(),
        source: 'OIL',
        type: 'price',
        value: +latest.toFixed(2),
        unit: 'USD/barrel',
        lat: null, lon: null,
        meta: { symbol: sym, label, region, change48h: +changePct.toFixed(2), prev: +prev24h.toFixed(2) },
        anomaly,
      });
    }
  } catch (e) { console.error('[OIL] Error:', e.message); }
  return events;
}

// ── 4. ADSB — Military Flight Activity ───────────────────────────────────────
// ADSBexchange public API — counts military callsigns in defined bounding boxes
// Anomaly = spike in military air activity in a zone
async function collectADSB() {
  const events = [];
  // Zones of interest
  const ZONES = [
    { name: 'Kashmir/LAC', lat1: 32, lon1: 74, lat2: 36, lon2: 80 },
    { name: 'Pakistan-India border', lat1: 28, lon1: 70, lat2: 34, lon2: 76 },
    { name: 'Strait of Hormuz', lat1: 25, lon1: 56, lat2: 28, lon2: 60 },
    { name: 'South China Sea', lat1: 5, lon1: 109, lat2: 22, lon2: 122 },
    { name: 'Taiwan Strait', lat1: 22, lon1: 119, lat2: 27, lon2: 123 },
    { name: 'Arabian Sea', lat1: 15, lon1: 58, lat2: 28, lon2: 72 },
  ];
  // Military hex code prefixes by country
  const MIL_PREFIXES = {
    'India': ['800', '801', '802', '803'],
    'Pakistan': ['760', '761'],
    'China': ['780', '781', '782', '783', '784'],
    'USA': ['AE', 'AF', 'A9'],
  };
  try {
    for (const zone of ZONES) {
      // ADSBexchange v2 API — free, no key needed for basic queries
      const url = `https://api.adsb.lol/v2/lat/${(zone.lat1+zone.lat2)/2}/lon/${(zone.lon1+zone.lon2)/2}/dist/200`;
      const res = await safeFetch(url);
      const data = await res.json();
      const ac = data.ac || [];
      // Count aircraft with military characteristics
      const milAc = ac.filter(a => {
        if (!a.hex) return false;
        const hex = a.hex.toUpperCase();
        // Military: government/special purpose transponder codes, or known mil hex ranges
        const isMilHex = Object.values(MIL_PREFIXES).flat().some(p => hex.startsWith(p));
        const isMilCall = a.flight && /^(RCH|REACH|FORTE|DUKE|SPAR|VALOR|JAKE|PAT\d|HAVOC|GHOST|VIPER|FURY|HAWK|EAGLE|ATLAS|ATLAS|USAF|ARMY|NAVY|JSOC)/.test(a.flight.trim());
        return isMilHex || isMilCall;
      });
      const count = milAc.length;
      updateBaseline('ADSB', zone.name, count);
      const anomaly = isAnomaly('ADSB', zone.name, count);
      if (count > 0 || anomaly) {
        events.push({
          id: `ADSB:${zone.name}:${Math.floor(Date.now() / 3600000)}`,
          ts: Date.now(),
          source: 'ADSB',
          type: 'military_air_activity',
          value: count,
          unit: 'military aircraft',
          lat: (zone.lat1 + zone.lat2) / 2,
          lon: (zone.lon1 + zone.lon2) / 2,
          meta: { zone: zone.name, aircraft: milAc.slice(0, 5).map(a => ({ hex: a.hex, call: a.flight?.trim(), alt: a.alt_baro })) },
          anomaly,
        });
      }
    }
  } catch (e) { console.error('[ADSB] Error:', e.message); }
  return events;
}

// ── 5. AIS — Maritime Ship Movements ─────────────────────────────────────────
// VesselFinder public data — warship concentrations in strategic straits
async function collectAIS() {
  const events = [];
  // Strategic maritime chokepoints
  const ZONES = [
    { name: 'Strait of Hormuz', lat: 26.6, lon: 56.4 },
    { name: 'Strait of Malacca', lat: 2.5, lon: 102.0 },
    { name: 'Bab-el-Mandeb', lat: 12.6, lon: 43.3 },
  ];
  try {
    for (const zone of ZONES) {
      // Use MarineTraffic free endpoint for vessel density
      const url = `https://www.marinetraffic.com/getData/get_data_json_4/z:7/X:${Math.floor((zone.lon+180)/360*128)}/Y:${Math.floor((90-zone.lat)/180*64)}/station:0`;
      const res = await safeFetch(url, { headers: { 'Referer': 'https://www.marinetraffic.com/' } }, 30000);
      if (!res.ok) continue;
      const data = await res.json();
      const vessels = data.data?.rows || [];
      // Count naval/military vessel types (type codes 35=military, 50-59=law enforcement)
      const navyVessels = vessels.filter(v => v.SHIPTYPE == 35 || (v.SHIPNAME && /\bHMAS\b|\bINS\b|\bUSS\b|\bPNS\b|\bPLA\b/.test(v.SHIPNAME)));
      const total = vessels.length;
      updateBaseline('AIS', zone.name, total);
      const anomaly = isAnomaly('AIS', zone.name, total);
      events.push({
        id: `AIS:${zone.name}:${Math.floor(Date.now() / 3600000)}`,
        ts: Date.now(),
        source: 'AIS',
        type: 'vessel_density',
        value: total,
        unit: 'vessels in zone',
        lat: zone.lat, lon: zone.lon,
        meta: { zone: zone.name, total, navyCount: navyVessels.length, navyVessels: navyVessels.slice(0,3).map(v => v.SHIPNAME) },
        anomaly: navyVessels.length > 3 ? { score: Math.min(100, navyVessels.length * 15), reason: `${navyVessels.length} naval vessels identified in ${zone.name}` } : anomaly,
      });
    }
  } catch (e) { console.error('[AIS] Error:', e.message); }
  return events;
}

// ── 6. OFFICIAL STATEMENTS — Govt Press Releases (RSS, no editorial) ─────────
// Raw statements from official government sources only
// These are facts: "India MoD issued X" — not analysis of what it means
async function collectOfficial() {
  const events = [];
  const OFFICIAL_FEEDS = [
    { name: 'India PIB Defence',  url: 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3', country: 'India' },
    { name: 'India MoD',          url: 'https://mod.gov.in/rss.xml', country: 'India' },
    { name: 'Pakistan ISPR',      url: 'https://www.ispr.gov.pk/feed/', country: 'Pakistan' },
    { name: 'US DoD News',        url: 'https://www.defense.gov/DesktopModules/ArticleCS/Feed.ashx?ContentType=1&Site=945&max=10', country: 'USA' },
    { name: 'US CENTCOM',         url: 'https://www.centcom.mil/MEDIA/RSS/', country: 'USA' },
    { name: 'China MoD',          url: 'http://eng.mod.gov.cn/xb/rss.xml', country: 'China' },
    { name: 'UN Security Council',url: 'https://www.un.org/press/en/rss.xml', country: 'UN' },
  ];
  for (const feed of OFFICIAL_FEEDS) {
    try {
      const res = await safeFetch(feed.url, {}, 30000);
      if (!res.ok) continue;
      const xml = await res.text();
      // Simple XML parse without xml2js — just pull title/link/date
      const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
      for (const match of itemMatches) {
        const block = match[1];
        const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/) || [])[1]?.trim();
        const link  = (block.match(/<link[^>]*>(.*?)<\/link>/) || [])[1]?.trim();
        const date  = (block.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1]?.trim();
        if (!title) continue;
        const ts = date ? new Date(date).getTime() : Date.now();
        if (isNaN(ts) || ts < Date.now() - 7 * 86400000) continue; // skip >7d old
        events.push({
          id: `OFFICIAL:${Buffer.from(title).toString('base64').slice(0,32)}`,
          ts,
          source: 'OFFICIAL',
          type: 'statement',
          value: 1,
          unit: 'statement',
          lat: null, lon: null,
          meta: { source: feed.name, country: feed.country, title, link },
          anomaly: null, // statements are facts — anomaly detection N/A
        });
      }
    } catch (e) { console.error(`[OFFICIAL:${feed.name}] Error:`, e.message); }
  }
  return events;
}

// ── 7. DEFENSE PROCUREMENT — India MoD Tenders ───────────────────────────────
// Raw procurement facts: "India issued tender for X qty of Y" = capability intent
async function collectProcurement() {
  const events = [];
  try {
    // India MoD procurement notices
    const res = await safeFetch('https://mod.gov.in/rss-tender.xml', {}, 30000);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const xml = await res.text();
    const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
    for (const match of itemMatches) {
      const block = match[1];
      const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/) || [])[1]?.trim();
      const link  = (block.match(/<link[^>]*>(.*?)<\/link>/) || [])[1]?.trim();
      const date  = (block.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1]?.trim();
      if (!title) continue;
      const ts = date ? new Date(date).getTime() : Date.now();
      events.push({
        id: `TENDER:${Buffer.from(title).toString('base64').slice(0,32)}`,
        ts,
        source: 'TENDER',
        type: 'procurement',
        value: 1,
        unit: 'tender',
        lat: null, lon: null,
        meta: { source: 'India MoD', title, link },
        anomaly: null,
      });
    }
  } catch (e) { console.error('[PROCUREMENT] Error:', e.message); }
  return events;
}

module.exports = {
  collectSeismic,
  collectFIRMS,
  collectOilPrice,
  collectADSB,
  collectAIS,
  collectOfficial,
  collectProcurement,
};
