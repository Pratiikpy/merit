#!/usr/bin/env node
/**
 * Render the architecture diagrams from their single source of truth.
 *
 * `docs/ARCHITECTURE.md` holds the Mermaid blocks — that file renders directly on GitHub, so it is what a
 * reader sees first. This script extracts those same blocks and renders them to SVG under `public/diagrams`,
 * which is what `/architecture.html` serves. Keeping one source means the page can never show a diagram the
 * documentation no longer describes.
 *
 * Run: npm run build-diagrams   (needs network access on first run: mermaid-cli via npx)
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(root, "docs", "ARCHITECTURE.md");
const OUT = path.join(root, "public", "diagrams");

// Ordered to match the sections of ARCHITECTURE.md; a new diagram needs a name here.
const NAMES = ["system", "money-path", "verification-engine", "network-config"];

const md = readFileSync(SOURCE, "utf8");
const blocks = [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
if (blocks.length !== NAMES.length) {
  console.error(`ARCHITECTURE.md has ${blocks.length} mermaid blocks but ${NAMES.length} names are configured.`);
  console.error("Add the new diagram's name to NAMES in this script, in document order.");
  process.exit(1);
}

// Mermaid treats ';' as a statement separator, so a semicolon inside a node or note silently truncates it and
// the parse fails several lines later. Catch it here rather than in a confusing parser error.
blocks.forEach((b, i) => {
  b.split("\n").forEach((line, n) => {
    const l = line.trim();
    if (l.includes(";") && !l.startsWith("classDef") && !l.startsWith("class ")) {
      console.error(`${NAMES[i]}: line ${n + 1} contains ';', which Mermaid reads as a statement separator:`);
      console.error(`  ${l.slice(0, 100)}`);
      process.exit(1);
    }
  });
});

mkdirSync(OUT, { recursive: true });
let failed = 0;
for (const [i, block] of blocks.entries()) {
  const name = NAMES[i];
  const mmd = path.join(OUT, `${name}.mmd`);
  writeFileSync(mmd, block, "utf8");
  try {
    // `shell: true` is required on Windows: Node 22 refuses to execFile a .cmd shim directly (EINVAL), and
    // npx is a .cmd there. The argument vector is fixed and contains no user input, so the shell adds no risk.
    execFileSync(
      "npx",
      ["-y", "@mermaid-js/mermaid-cli@11", "-i", mmd, "-o", path.join(OUT, `${name}.svg`), "-b", "transparent", "-w", "1100"],
      { stdio: "inherit", cwd: OUT, shell: true },
    );
    console.log(`rendered ${name}.svg`);
  } catch {
    console.error(`FAILED to render ${name}`);
    failed += 1;
  } finally {
    // The .mmd is an intermediate, not an artifact — the Markdown is the source.
    rmSync(mmd, { force: true });
  }
}
process.exit(failed ? 1 : 0);
