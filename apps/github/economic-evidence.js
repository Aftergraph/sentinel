import { verifyEconomicEvidenceCampaign } from "../../lib/economic-evidence-campaign.js";
import { verifyEconomicEvidencePack } from "../../lib/economic-evidence-pack.js";

const ENVELOPE_SCHEMA="aftergraph.economic-github-evidence-envelope/v1";
const PACK_PATH=/^docs\/evidence\/economic-campaigns\/[^/]+\/evidence-pack\.json$/;

export function economicEvidenceEnvelopePaths(diffText){
  const paths=[];
  for(const line of String(diffText||"").split("\n")){
    const m=/^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if(!m) continue;
    if(PACK_PATH.test(m[2])) paths.push(m[2]);
  }
  return [...new Set(paths)].sort();
}

export async function verifyEconomicEvidenceEnvelope({repo,headSha,diffText,platform}){
  const paths=economicEvidenceEnvelopePaths(diffText);
  if(paths.length!==1){
    return {
      valid:false,
      state:"EVIDENCE_ENVELOPE_REQUIRED",
      path:paths[0]??null,
      reasons:[paths.length===0?"envelope_missing":"multiple_envelopes"],
      campaign:null,
      pack:null
    };
  }
  if(!platform||typeof platform.getFileContent!=="function"){
    throw new Error("platform missing getFileContent (fail closed)");
  }

  let parsed;
  try{
    const raw=await platform.getFileContent(repo,paths[0],headSha);
    parsed=JSON.parse(raw);
  }catch(err){
    return {
      valid:false,
      state:"EVIDENCE_ENVELOPE_INVALID",
      path:paths[0],
      reasons:["envelope_read_or_json:"+String(err?.message||err)],
      campaign:null,
      pack:null
    };
  }

  const reasons=[];
  if(parsed?.schema!==ENVELOPE_SCHEMA) reasons.push("envelope_schema");
  if(parsed?.headSha!==headSha) reasons.push("head_sha_binding");
  if(parsed?.repository!==repo) reasons.push("repository_binding");
  if(parsed?.executionAuthority!==false) reasons.push("execution_authority");
  if(parsed?.liveValueEnabled!==false) reasons.push("live_value");
  if(parsed?.externalEffects!==0) reasons.push("external_effects");
  if(parsed?.final!==false) reasons.push("finality");

  let campaign=null,pack=null;
  try{
    campaign=verifyEconomicEvidenceCampaign(parsed?.campaign);
    if(!campaign?.valid) reasons.push("campaign_invalid");
  }catch(err){
    reasons.push("campaign_exception:"+String(err?.message||err));
  }
  try{
    pack=verifyEconomicEvidencePack(parsed?.evidencePack);
    if(!pack?.valid) reasons.push("evidence_pack_invalid");
  }catch(err){
    reasons.push("evidence_pack_exception:"+String(err?.message||err));
  }

  if(campaign?.packHash && parsed?.evidencePack?.pack?.campaignId!==campaign?.campaignId){
    reasons.push("campaign_pack_id_binding");
  }

  const unique=[...new Set(reasons)].sort();
  return {
    valid:unique.length===0,
    state:unique.length===0?"VERIFIED_EVIDENCE_PACK":"EVIDENCE_ENVELOPE_INVALID",
    path:paths[0],
    reasons:unique,
    campaign,
    pack
  };
}
