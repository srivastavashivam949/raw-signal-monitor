# Raw Signal Monitor

No editorial sources. No think tanks. No opinions.
Only raw sensor data, API feeds, and official government statements.

## Sources
- SEISMIC  — USGS earthquake API (underground tests = shallow + high magnitude)
- FIRMS    — NASA satellite thermal anomalies (airstrikes, explosions, depot fires)
- OIL      — Brent/WTI price via Yahoo Finance (conflict risk barometer)
- ADSB     — Military flight activity via adsb.lol (aircraft counts per zone)
- AIS      — Vessel density at Hormuz, Malacca, Bab-el-Mandeb
- OFFICIAL — Raw govt press releases: India PIB, Pakistan ISPR, US DoD/CENTCOM, China MoD, UN
- TENDER   — India MoD procurement tenders (capability acquisition intent)

## Anomaly Detection
Z-score > 2.0 standard deviations from rolling 7-day baseline.
Baselines need 12 samples to activate. System learns your regional norms.

## Setup

cd raw-signal-monitor
npm install

## Run

$env:GROK_API_KEY="xai-..."     (PowerShell)
node server.js

Open: http://localhost:3737

## What Grok does
Receives only raw event data (numbers, timestamps, coordinates).
Identifies statistical co-occurrences across signal types.
Does NOT receive any editorial text. Does NOT speculate on intent.
You interpret. The system only surfaces deviations.
