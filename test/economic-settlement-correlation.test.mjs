import test from "node:test";
import assert from "node:assert/strict";
import { verifySettlementCorrelation } from "../lib/economic-settlement-correlation.js";

const H = c => "sha256:" + c.repeat(64);

function fixture() {
  const obligations = [
    {legId:"asset",kind:"asset",rail:"rail-asset-a",obligationHash:H("c"),legalBindingHash:H("b")},
    {legId:"cash",kind:"cash",rail:"rail-cash-b",obligationHash:H("d"),legalBindingHash:H("b")}
  ];
  const receipts = [
    {
      schema:"aftergraph.rail-settlement-receipt/v1",
      economicTransactionId:"econ_corr_1",
      legId:"asset",kind:"asset",rail:"rail-asset-a",
      obligationHash:H("c"),legalBindingHash:H("b"),
      sourceEvidenceHash:H("e"),outcome:"COMMITTED",
      externalEffects:0,final:false
    },
    {
      schema:"aftergraph.rail-settlement-receipt/v1",
      economicTransactionId:"econ_corr_1",
      legId:"cash",kind:"cash",rail:"rail-cash-b",
      obligationHash:H("d"),legalBindingHash:H("b"),
      sourceEvidenceHash:H("f"),outcome:"COMMITTED",
      externalEffects:0,final:false
    }
  ];
  return {
    economicTransactionId:"econ_corr_1",
    intentHash:H("a"),
    legalBindingHash:H("b"),
    obligations,
    receipts,
    correlation:{
      schema:"aftergraph.economic-settlement-correlation/v1",
      economicTransactionId:"econ_corr_1",
      intentHash:H("a"),
      legalBindingHash:H("b"),
      state:"CORRELATED",
      final:false,
      externalEffects:0,
      reconciliationRequired:false,
      matchedLegs:["asset","cash"],
      reasons:[]
    }
  };
}

test("independently verifies same-economic-transaction correlation",()=>{
  const out=verifySettlementCorrelation(fixture());
  assert.equal(out.valid,true);
  assert.equal(out.sameEconomicTransactionVerified,true);
  assert.equal(out.state,"VERIFIED_SAME_ECONOMIC_TRANSACTION");
  assert.equal(out.final,false);
  assert.equal(out.promotionAuthority,false);
  assert.equal(out.externalEffects,0);
});

for (const [name, mutate] of [
  ["transaction id mismatch", x => { x.receipts[1].economicTransactionId="econ_other"; }],
  ["obligation hash mismatch", x => { x.receipts[0].obligationHash=H("d"); }],
  ["legal binding mismatch", x => { x.receipts[0].legalBindingHash=H("a"); }],
  ["missing cash receipt", x => { x.receipts=x.receipts.slice(0,1); }],
  ["unknown outcome", x => { x.receipts[1].outcome="UNKNOWN"; }],
  ["reused evidence", x => { x.receipts[1].sourceEvidenceHash=x.receipts[0].sourceEvidenceHash; }],
  ["receipt finality overclaim", x => { x.receipts[0].final=true; }],
  ["external effect overclaim", x => { x.receipts[0].externalEffects=1; }]
]) {
  test("rejects "+name,()=>{
    const x=fixture(); mutate(x);
    x.correlation.state="UNCERTAIN";
    x.correlation.reconciliationRequired=true;
    x.correlation.matchedLegs=[];
    const out=verifySettlementCorrelation(x);
    assert.equal(out.valid,false);
    assert.equal(out.state,"RECONCILIATION_REQUIRED");
    assert.equal(out.final,false);
  });
}

test("rejects WORKS success overclaim when underlying receipts disagree",()=>{
  const x=fixture();
  x.receipts[1].obligationHash=H("c");
  const out=verifySettlementCorrelation(x);
  assert.equal(out.valid,false);
  assert.ok(out.reasons.includes("correlation_overclaims_success"));
});

test("rejects correlation claiming FINAL even when receipts match",()=>{
  const x=fixture();
  x.correlation.final=true;
  const out=verifySettlementCorrelation(x);
  assert.equal(out.valid,false);
});
