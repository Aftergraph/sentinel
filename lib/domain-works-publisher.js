function isLoopback(hostname){return hostname==='127.0.0.1'||hostname==='localhost'||hostname==='::1'||hostname==='[::1]';}
function nonEmpty(value){return typeof value==='string'&&value.trim()!==''?value.trim():null;}

export function createWorksVerificationPublisher({baseUrl,token,fetchImpl=fetch,timeoutMs=5000}={}){
  let base;
  try{base=new URL(baseUrl);}
  catch{throw new Error('works_base_url_required');}
  if(base.protocol!=='https:'&&!isLoopback(base.hostname))throw new Error('works_https_required');
  if(typeof token!=='string'||Buffer.byteLength(token,'utf8')<32)throw new Error('token_min_32_bytes');
  if(typeof fetchImpl!=='function')throw new Error('fetch_required');
  return async function publishDomainVerification({receipt,envelope}={}){
    if(receipt?.verdict==='INDETERMINATE')return {published:false,reason:'non_terminal_verdict'};
    const result=receipt?.verdict==='VERIFIED'?'passed':receipt?.verdict==='REJECTED'?'failed':null;
    const missionId=nonEmpty(envelope?.subject?.missionId);
    const receiptId=nonEmpty(receipt?.receiptId);
    const verifierRef=nonEmpty(receipt?.verifierRef);
    const verifiedAt=nonEmpty(receipt?.verifiedAt);
    if(!result||!missionId||!/^dvr_[a-f0-9]{64}$/.test(receiptId||'')||!verifierRef||!verifiedAt){
      throw new Error('invalid_domain_verification_publish_input');
    }
    const target=new URL(`/v1/works/${encodeURIComponent(missionId)}/verification`,base);
    let response;
    try{
      response=await fetchImpl(target,{method:'POST',headers:{'content-type':'application/json','x-works-verifier-token':token},body:JSON.stringify({result,verifier_id:verifierRef,evidence_ref:receiptId,verified_at:verifiedAt}),signal:AbortSignal.timeout(timeoutMs)});
    }catch{throw new Error('works_verification_publish_failed');}
    if(!response?.ok)throw new Error('works_verification_publish_failed');
    return {published:true,workId:missionId,receiptId,result};
  };
}
