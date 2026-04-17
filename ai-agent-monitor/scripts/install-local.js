#!/usr/bin/env node
/* eslint-disable no-console */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function exists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.error) {
    return { ok: false, code: 1, error: result.error };
  }
  return { ok: result.status === 0, code: result.status ?? 1 };
}

function canRun(cmd) {
  const probe = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

function resolveInstallerCandidates() {
  const candidates = [];

  // Prefer PATH binaries when available.
  for (const name of ['cursor', 'antigravity', 'code']) {
    if (canRun(name)) {
      candidates.push({ label: name, cmd: name });
    }
  }

  // macOS app bundle fallbacks.
  const macCandidates = [
    { label: 'Cursor', cmd: '/Applications/Cursor.app/Contents/Resources/app/bin/cursor' },
    { label: 'Antigravity', cmd: '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity' },
    { label: 'VS Code', cmd: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' },
  ];

  for (const candidate of macCandidates) {
    if (exists(candidate.cmd)) {
      candidates.push(candidate);
    }
  }

  // Dedup by cmd.
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.cmd)) return false;
    seen.add(candidate.cmd);
    return true;
  });
}

function main() {
  const vsixArg = process.argv[2];
  if (!vsixArg) {
    console.error('Usage: node scripts/install-local.js <path-to-vsix>');
    process.exit(2);
  }

  const vsixPath = path.resolve(process.cwd(), vsixArg);
  if (!fs.existsSync(vsixPath)) {
    console.error(`VSIX not found: ${vsixPath}`);
    process.exit(2);
  }

  const installers = resolveInstallerCandidates();
  if (installers.length === 0) {
    console.error("No VS Code-compatible CLI found. Install one of: 'cursor', 'antigravity', or 'code' in PATH.");
    process.exit(1);
  }

  // Install into every available host so local dev is easy.
  let anySuccess = false;
  for (const installer of installers) {
    // Some CLIs print errors to stderr but still return 0; we rely on exit code.
    const result = run(installer.cmd, ['--install-extension', vsixPath, '--force']);
    if (result.ok) {
      anySuccess = true;
    }
  }

  process.exit(anySuccess ? 0 : 1);
}

main();

