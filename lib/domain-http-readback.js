function isLoopback(hostname){return hostname==='127.0.0.1'||hostname==='localhost'||hostname==='::1'||hostname==='[::1]';}
function nonEmpty(value){return typeof value==='string'&&value.trim()!==''?value.trim():null;}

function boundedSubject(subject){
  if(!subject||typeof subject!=='object'||Array.isArray(subject))throw new Error('domain_readback_subject_invalid');
  const out={};
  for(const key of ['tenantId','missionId','effectId','idempotencyKey','subjectRef','executorRef']){
    const value=nonEmpty(subject[key]);
    if(!value)throw new Error('domain_readback_subject_invalid');
    out[key]=value;
  }
  return Object.freeze(out);
}

async function readBoundedJson(response,maxBytes=64*1024){
  const reader=response?.body?.getReader?.();
  if(!reader)throw new Error('domain_readback_failed');
  const chunks=[];let size=0;
  try{
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>maxBytes){await reader.cancel();throw new Error('domain_readback_failed');}
      chunks.push(value);
    }
  }catch{throw new Error('domain_readback_failed');}
  let parsed;
  try{parsed=JSON.parse(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk))).toString('utf8'));}
  catch{throw new Error('domain_readback_failed');}
  return parsed;
}
export function createDomainHttpReadback({baseUrl,token,fetchImpl=fetch,timeoutMs=5000}={}){
  let base;
  try{base=new URL(baseUrl);}catch{throw new Error('observer_base_url_required');}
  if(base.protocol!=='https:'&&!isLoopback(base.hostname))throw new Error('observer_https_required');
  if(typeof token!=='string'||Buffer.byteLength(token,'utf8')<32)throw new Error('token_min_32_bytes');
  if(typeof fetchImpl!=='function')throw new Error('fetch_required');
  return async function observeDomainReadback({subject}={}){
    const payload={subject:boundedSubject(subject)};
    const target=new URL('/v1/domain/readback',base);
    let response;
    try{
      response=await fetchImpl(target,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(payload),signal:AbortSignal.timeout(timeoutMs)});
    }catch{throw new Error('domain_readback_failed');}
    if(!response?.ok)throw new Error('domain_readback_failed');
    const observed=await readBoundedJson(response);
    if(!observed||typeof observed!=='object'||Array.isArray(observed))throw new Error('domain_readback_failed');
    const status=nonEmpty(observed.status);
    const evidenceRef=nonEmpty(observed.evidenceRef);
    if(!['MATCH','MISMATCH','MISSING','TIMEOUT'].includes(status||''))throw new Error('domain_readback_failed');
    if((status==='MATCH'||status==='MISMATCH')&&!evidenceRef)throw new Error('domain_readback_failed');
    return Object.freeze({status,...(evidenceRef?{evidenceRef}:{} )});
  };
}
