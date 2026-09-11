#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';

import { verifyCapturedCampaign } from '../lib/model-evidence-verifier.js';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath) {
  console.error('usage: node scripts/verify-model-evidence.mjs <input.json> [attestation.json]');
  process.exit(2);
}

try {
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const attestation = verifyCapturedCampaign(input);
  const encoded = `${JSON.stringify(attestation, null, 2)}\n`;
  if (outputPath) fs.writeFileSync(outputPath, encoded, { flag: 'wx' });
  process.stdout.write(encoded);
  process.exit(attestation.verdict === 'PASS' ? 0 : 1);
} catch (error) {
  console.error(`verification_error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
