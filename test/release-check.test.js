// Release check (#6763): the published tarball is an allowlist, so a new file cannot ship unreviewed.
// Fast: one `npm pack --dry-run --json` (no network, no registry write) plus a few file reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Adding or removing a shipped file means editing this list in the same change, which puts it in review.
const EXPECTED_FILES = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "index.js",
  "lib/billing.js",
  "lib/guidance.js",
  "lib/http-guards.js",
  "lib/own-data.js",
  "lib/tools.js",
  "package.json",
  "server.js",
];

function packedFiles() {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return JSON.parse(out)[0].files.map((f) => f.path).sort();
}

test("the tarball holds exactly the expected files", () => {
  assert.deepEqual(packedFiles(), EXPECTED_FILES);
});

test("no test, Docker, deploy, env or lockfile is published", () => {
  const banned = /(^|\/)(test|tests)\/|dockerfile|\.dockerignore|fly\.toml|\.env|lock(file)?\.|package-lock|pnpm-lock|\.tgz$|smithery|manifest\.json/i;
  assert.deepEqual(packedFiles().filter((p) => banned.test(p)), []);
});

test("package.json is publishable", () => {
  assert.equal(pkg.name, "repyh-mcp");
  assert.notEqual(pkg.private, true);
  assert.equal(pkg.publishConfig?.access, "public");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.engines?.node, ">=20");
  assert.equal(pkg.type, "module");
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, "files allowlist is required");
  assert.ok(pkg.description.trim().length > 0 && pkg.description.length <= 140, "description is non-empty and at most 140 characters");
});

test("public metadata does not point at a private repository", () => {
  const url = JSON.stringify([pkg.repository, pkg.homepage, pkg.bugs]);
  assert.doesNotMatch(url, /NUAIai\/Founder|repyh-com\/Founder/i);
});

test("bin and main exist, ship, and the bin file is an executable script", () => {
  const files = packedFiles();
  const bins = Object.values(pkg.bin);
  for (const f of [pkg.main, ...bins]) {
    assert.ok(files.includes(f.replace(/^\.\//, "")), `${f} is in the tarball`);
  }
  for (const b of bins) {
    assert.ok(readFileSync(join(root, b), "utf8").startsWith("#!/usr/bin/env node"), `${b} has a shebang`);
    assert.ok(statSync(join(root, b)).mode & 0o111, `${b} is executable`);
  }
});

test("every shipped script parses and imports only declared dependencies", () => {
  const declared = new Set(Object.keys(pkg.dependencies ?? {}));
  for (const f of packedFiles().filter((p) => p.endsWith(".js"))) {
    execFileSync(process.execPath, ["--check", join(root, f)]);
    const src = readFileSync(join(root, f), "utf8");
    const imports = /^(?:import|export)\b[^;"']*?from\s*["']([^"']+)["']|^import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;
    for (const m of src.matchAll(imports)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith("node:") || spec.startsWith(".")) continue;
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      assert.ok(declared.has(name), `${f} imports ${name}, which is not in dependencies`);
    }
  }
});

test("the version has a CHANGELOG heading and no Unreleased section ships", () => {
  // Rule: `## <version>` (optionally followed by text) must exist; there is no "or Unreleased" escape.
  const log = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const esc = pkg.version.replace(/\./g, "\\.");
  assert.match(log, new RegExp(`^## \\[?${esc}\\]?(\\s|$)`, "m"), `CHANGELOG.md has no "## ${pkg.version}" heading`);
  assert.doesNotMatch(log, /^## Unreleased/m);
});

test("no shipped file carries an internal reference (issue number, repository path)", () => {
  const internal = /#\d{4,}|packages\/|backend\//;
  for (const f of packedFiles()) {
    if (f === "package.json") continue;
    assert.doesNotMatch(readFileSync(join(root, f), "utf8"), internal, `${f} has an internal reference`);
  }
});
