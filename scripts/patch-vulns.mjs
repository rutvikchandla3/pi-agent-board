#!/usr/bin/env node
/**
 * postinstall: patch vulnerable transitive dependencies that are locked behind
 * @earendil-works/pi-coding-agent's npm-shrinkwrap.json (which prevents npm
 * "overrides" from taking effect).
 *
 * Vulnerabilities patched:
 * - brace-expansion <=5.0.7 → 5.0.8 (GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg)
 * - protobufjs 7.5.0–7.6.4 → 7.6.5 (GHSA-j3f2-48v5-ccww)
 */
import { execSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nested = join(
  root,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "node_modules",
);

const patches = [
  { name: "brace-expansion", version: "5.0.8" },
  { name: "protobufjs", version: "7.6.5" },
];

for (const { name, version } of patches) {
  const target = join(nested, name);
  if (!existsSync(target)) {
    console.log(`[patch-vulns] ${name} not found nested, skipping`);
    continue;
  }

  console.log(`[patch-vulns] patching ${name} → ${version}`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  // Install the patched version into a temp dir, then move it into place
  const tmp = join(root, `.patch-tmp-${name}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  try {
    execSync(`npm install ${name}@${version} --prefix "${tmp}" --ignore-scripts`, {
      stdio: "pipe",
      cwd: root,
    });
    const installed = join(tmp, "node_modules", name);
    rmSync(target, { recursive: true, force: true });
    execSync(`mv "${installed}" "${target}"`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log("[patch-vulns] done");
