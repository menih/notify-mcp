#!/usr/bin/env node
// Auto-capture screenshots of the running config UI for use in READMEs and
// marketplace listings. Run from the repo root with the UI server running on
// :3737 (or set PORT env var).
//
// Usage:   node scripts/screenshot.js
// Output:  assets/screenshots/{main-ui,help,activity-log}.png

import { chromium } from "playwright";
import { mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const PORT = process.env.PORT || 3737;
const BASE = `http://localhost:${PORT}`;
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "assets", "screenshots");

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const shots = [
  {
    name: "main-ui",
    url: BASE,
    waitFor: ".section-channels",
    width: 1600,
    height: 900,
    description: "Main config page — Delivery Channels + System Policies",
  },
  {
    name: "help-page",
    url: `${BASE}/help.html`,
    waitFor: ".help-section",
    width: 1200,
    height: 1400,
    description: "Help page with copy-paste snippets per client",
    fullPage: true,
  },
];

async function main() {
  // Verify the server is up before launching browser.
  try {
    const res = await fetch(`${BASE}/api/config`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(`ERROR: UI server not reachable at ${BASE}`);
    console.error(`       Start it first: node dist/ui/server.js`);
    console.error(`       Detail: ${err.message}`);
    process.exit(1);
  }

  const browser = await chromium.launch();
  console.log(`Capturing screenshots from ${BASE}...`);

  for (const shot of shots) {
    const ctx = await browser.newContext({
      viewport: { width: shot.width, height: shot.height },
      deviceScaleFactor: 2, // retina-quality output
      colorScheme: "dark",
    });
    const page = await ctx.newPage();
    try {
      // Use 'domcontentloaded' instead of 'networkidle' — the main page has
      // long-lived SSE streams (logs + inbox) that never let networkidle fire.
      await page.goto(shot.url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForSelector(shot.waitFor, { timeout: 8000 });
      // Give the dynamic DOM (badges, channel rendering) a beat to settle.
      await page.waitForTimeout(800);
      const out = join(OUT_DIR, `${shot.name}.png`);
      await page.screenshot({ path: out, fullPage: !!shot.fullPage });
      console.log(`  ✓ ${shot.name}.png — ${shot.description}`);
    } catch (err) {
      console.error(`  ✗ ${shot.name} failed: ${err.message}`);
    } finally {
      await ctx.close();
    }
  }

  await browser.close();
  console.log(`Done. Output in ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
