#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { verifyLabsPreflight } from "../lib/labs-preflight-verifier.js";

const args = process.argv.slice(2);
let receiptPath = "";
let outPath = "";
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--receipt") receiptPath = args[++i] || "";
  else if (args[i] === "--out") outPath = args[++i] || "";
}
if (!receiptPath || !outPath) {
  process.stderr.write("Usage: node scripts/verify-labs-preflight.mjs --receipt <receipt.json> --out <verification.json>\n");
  process.exit(64);
}

try {
  const receipt = JSON.parse(await readFile(resolve(receiptPath), "utf8"));
  const verification = verifyLabsPreflight(receipt);
  const target = resolve(outPath);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(verification, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, target);
  process.stdout.write(JSON.stringify({
    state: verification.state,
    valid: verification.valid,
    verificationDigest: verification.verificationDigest,
    output: target
  }) + "\n");
  process.exitCode = verification.valid ? 0 : 2;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "verification failed"}\n`);
  process.exitCode = 1;
}
