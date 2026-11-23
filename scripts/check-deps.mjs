// Checks that Node.js and every dependency in package.json match what the
// project needs, before any npm script runs.
//
// Without this, a stale node_modules (e.g. after pulling a branch that adds a
// package) only shows up later as a cryptic "Failed to resolve import ..." from
// Vite, pointing at the source file instead of at the missing package.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// An old Node fails later with cryptic Vite/Rolldown errors, so stop here with
// an actionable message instead (issue #64).
const requiredNode = pkg.engines?.node;
if (requiredNode && !satisfies(process.versions.node, requiredNode)) {
  console.error(
    `Node.js ${process.versions.node} is too old; package.json requires ${requiredNode} (see .nvmrc).`,
  );
  console.error('Switch to the required Node version (e.g. "nvm use") and repeat the command.');
  process.exit(1);
}

/** The file a bundler would load for a package: `exports.default`, `module` or `main`. */
function entryFile(manifest) {
  const exports = manifest.exports;
  if (typeof exports === "string") return exports;
  if (exports && typeof exports === "object") {
    const def = exports.default ?? exports.import ?? exports.require;
    if (typeof def === "string") return def;
  }
  return manifest.module ?? manifest.main ?? null;
}

/**
 * Checks an installed version against a range npm wrote for us
 * ("^1.2.3", "~1.2.3", "1.2.3", "*") or a minimum like the ">=26" in
 * engines.node. Everything else is left to npm.
 */
function satisfies(version, range) {
  if (!version || range === "*" || range === "latest") return true;
  const found = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  const wanted = range.match(/^(>=|\^|~)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!found || !wanted) return true;

  const v = [Number(found[1]), Number(found[2]), Number(found[3])];
  const op = wanted[1] ?? "";
  const major = Number(wanted[2]);
  const minor = Number(wanted[3] ?? 0);
  const patch = Number(wanted[4] ?? 0);

  if (op === "") return v[0] === major && v[1] === minor && v[2] === patch;
  if (op === ">=") {
    return v[0] > major || (v[0] === major && (v[1] > minor || (v[1] === minor && v[2] >= patch)));
  }
  if (op === "~") return v[0] === major && v[1] === minor && v[2] >= patch;
  // "^": compatible with the range, so the major stays the same (0.x is special).
  if (major > 0) return v[0] === major && (v[1] > minor || (v[1] === minor && v[2] >= patch));
  if (minor > 0) return v[0] === 0 && v[1] === minor && v[2] >= patch;
  return v[0] === 0 && v[1] === 0 && v[2] === patch;
}

const missing = [];
const outdated = [];

for (const [group, deps] of [
  ["dependencies", pkg.dependencies ?? {}],
  ["devDependencies", pkg.devDependencies ?? {}],
]) {
  for (const [name, range] of Object.entries(deps)) {
    const dir = join(root, "node_modules", name);
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) {
      missing.push(`${name}@${range}`);
      continue;
    }

    const installed = JSON.parse(readFileSync(manifest, "utf8"));
    const entry = entryFile(installed);
    if (entry && !existsSync(join(dir, entry))) {
      missing.push(`${name}@${installed.version} (incomplete: ${entry} is missing)`);
      continue;
    }
    if (!satisfies(installed.version, range)) {
      outdated.push(`${name}: installed ${installed.version}, needs ${range}`);
    }
  }
}

if (outdated.length) {
  console.warn("Note: installed versions do not match package.json:");
  for (const line of outdated) console.warn(`  - ${line}`);
  console.warn('Run "npm install" to update them.\n');
}

if (missing.length) {
  console.error("Installed dependencies are missing:");
  for (const line of missing) console.error(`  - ${line}`);
  console.error('\nRun "npm install" and then repeat the command.');
  process.exit(1);
}
