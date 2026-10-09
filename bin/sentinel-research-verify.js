#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { verifyResearchEvidence } from '../lib/research-evidence-verification.js';

const {values}=parseArgs({
  options:{'verifier-ref':{type:'string'}},
  strict:true,
  allowPositionals:false,
});
const verifierRef=values['verifier-ref'];
let raw='';
for await(const chunk of process.stdin)raw+=chunk;
let envelope;
try{envelope=JSON.parse(raw);}
catch{
  process.stderr.write('invalid_json\n');
  process.exit(2);
}
const out=verifyResearchEvidence({envelope,verifierRef});
process.stdout.write(JSON.stringify(out)+'\n');
process.exit(out.verdict==='VERIFIED'?0:out.verdict==='REJECTED'?1:2);
