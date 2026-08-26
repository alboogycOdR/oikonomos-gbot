#!/usr/bin/env node
/**
 * Reject realistic credential variable names and live hostnames in fixtures.
 * Fixture-only scope preserves legitimate production configuration while
 * preventing examples from becoming copied-and-pasted unsafe defaults.
 */
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { walkFiles } from './lib/walk.mjs';

const FIXTURE_DIRECTORY = /(^|\/)(?:fixtures?|__fixtures__|testdata)(?:\/|$)/i;
const HOSTNAME = /\bhttps?:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)\b/gi;

export function providerEnvironmentNames() {
  return [
    ['ANTHROPIC', 'API_KEY'].join('_'),
    ['OPENAI', 'API_KEY'].join('_'),
    ['GOOGLE', 'API_KEY'].join('_'),
    ['GEMINI', 'API_KEY'].join('_'),
    ['COHERE', 'API_KEY'].join('_'),
    ['MISTRAL', 'API_KEY'].join('_'),
    ['GROQ', 'API_KEY'].join('_'),
    ['XAI', 'API_KEY'].join('_'),
  ];
}

export function isFixturePath(relativePath) {
  return FIXTURE_DIRECTORY.test(relativePath.replace(/\\/g, '/'));
}

export function isReservedHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.test')
    || normalized.endsWith('.invalid')
    || normalized.endsWith('.example')
    || ['example.com', 'example.net', 'example.org'].some(
      (domain) => normalized === domain || normalized.endsWith(`.${domain}`),
    );
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split(/\r?\n/).length;
}

export function scanNegativeControls({ root = process.cwd() } = {}) {
  const base = resolve(root);
  const findings = [];
  for (const absolutePath of walkFiles(base)) {
    const relativePath = relative(base, absolutePath).replace(/\\/g, '/');
    if (!isFixturePath(relativePath)) continue;
    let text;
    try {
      text = readFileSync(absolutePath, 'utf8');
    } catch {
      continue;
    }
    for (const environmentName of providerEnvironmentNames()) {
      let offset = text.indexOf(environmentName);
      while (offset !== -1) {
        findings.push({ file: relativePath, line: lineNumber(text, offset), kind: 'provider-env-name', value: environmentName });
        offset = text.indexOf(environmentName, offset + environmentName.length);
      }
    }
    HOSTNAME.lastIndex = 0;
    for (let match = HOSTNAME.exec(text); match !== null; match = HOSTNAME.exec(text)) {
      const hostname = match[1].toLowerCase();
      if (!isReservedHostname(hostname)) {
        findings.push({ file: relativePath, line: lineNumber(text, match.index), kind: 'live-hostname', value: hostname });
      }
    }
  }
  return findings;
}

function parseArgs(argv) {
  const options = { root: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') options.root = argv[++index];
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write('Usage: node infra/ci/negative-controls.mjs [--root DIR]\n');
      return 0;
    }
    const findings = scanNegativeControls(options);
    if (findings.length === 0) {
      process.stdout.write('negative-controls: clean (fixture provider names and hostnames are safe)\n');
      return 0;
    }
    process.stderr.write(`negative-controls: ${findings.length} forbidden fixture value(s)\n`);
    for (const finding of findings) {
      process.stderr.write(`  ${finding.file}:${finding.line}: ${finding.kind}: ${finding.value}\n`);
    }
    return 1;
  } catch (error) {
    process.stderr.write(`negative-controls: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
