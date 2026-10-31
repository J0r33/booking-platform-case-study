#!/usr/bin/env node
// Docs link check. Every relative link and image in the repo's Markdown must point at a file
// that exists, so an excerpt or screenshot can't be renamed out from under the write-up.
//
// Fails closed:
//   - a relative link points at a missing file  -> FAIL
//   - no Markdown files, or no links, examined  -> FAIL (checked nothing)
//
// Usage (from the repo root): node scripts/check-links.mjs

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const markdown = readdirSync(".", { recursive: true })
  .filter((f) => f.endsWith(".md") && !f.startsWith(".git") && !f.includes("node_modules"));

let checked = 0;
const broken = [];
for (const file of markdown) {
  const text = readFileSync(file, "utf8");
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = join(dirname(file), decodeURIComponent(target.split("#")[0]));
    checked++;
    if (!existsSync(path)) broken.push(`${file}: ${target}`);
  }
}

if (markdown.length === 0 || checked === 0) {
  console.error(`::error::Examined ${markdown.length} Markdown files and ${checked} links. This check proved NOTHING.`);
  process.exit(1);
}
for (const b of broken) console.error(`::error::Broken relative link: ${b}`);
console.log(`Checked ${checked} relative links in ${markdown.length} Markdown files; ${broken.length} broken.`);
process.exit(broken.length ? 1 : 0);
