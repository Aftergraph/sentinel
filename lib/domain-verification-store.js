import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { append } from './audit.js';
import { verifyDomainVerificationReceipt } from './domain-verification.js';

function requirePath(filePath){
  if(typeof filePath!=='string'||!filePath.trim())throw new Error('domain-verification-store: filePath required');
  return filePath;
}
function deepFreeze(value){
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    Object.freeze(value);
    for(const nested of Object.values(value))deepFreeze(nested);
  }
  return value;
}
function freezeReceipt(raw){
  return deepFreeze(structuredClone(raw));
}
function assertReceipt(receipt){
  if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))throw new Error('domain-verification-store: invalid receipt');
  if(!verifyDomainVerificationReceipt(receipt))throw new Error('domain-verification-store: reject tampered receipt digest');
  return true;
}function loadFile(filePath){
  if(!existsSync(filePath))return {receipts:[]};
  let parsed;
  try{parsed=JSON.parse(readFileSync(filePath,'utf8'));}
  catch{throw new Error(`domain-verification-store: corrupt store file (${filePath})`);}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||!Array.isArray(parsed.receipts)){
    throw new Error(`domain-verification-store: corrupt store file (${filePath})`);
  }
  for(const receipt of parsed.receipts){
    if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)){
      throw new Error(`domain-verification-store: corrupt store file (${filePath})`);
    }
  }
  return {receipts:parsed.receipts.map(freezeReceipt)};
}
function persist(filePath,state){
  mkdirSync(dirname(filePath),{recursive:true});
  const tmp=`${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp,JSON.stringify(state,null,2)+'\n');
  renameSync(tmp,filePath);
}

export function createDomainVerificationStore(filePath){
  requirePath(filePath);
  let state=loadFile(filePath);
  const save=()=>persist(filePath,state);  const store={
    filePath,
    reload(){state=loadFile(filePath);return true;},
    put(receipt){
      assertReceipt(receipt);
      const existing=state.receipts.find(item=>item.receiptId===receipt.receiptId);
      if(existing)return existing;
      const stored=freezeReceipt(receipt);
      state={receipts:[...state.receipts,stored]};
      save();
      append('domain-verification.stored',{
        findingId:null,
        from:stored.subjectId??null,
        to:stored.receiptId,
        actor:'domain-verification-store',
        reason:`domain-verification:stored:${stored.receiptId}`,
      });
      return stored;
    },
    get(receiptId){
      if(typeof receiptId!=='string'||!receiptId)return null;
      const found=state.receipts.find(item=>item.receiptId===receiptId)||null;
      if(found)assertReceipt(found);
      return found;
    },
    listBySubject(subjectId){
      if(typeof subjectId!=='string'||!subjectId)return [];
      const matches=state.receipts.filter(item=>item.subjectId===subjectId);
      for(const item of matches)assertReceipt(item);
      return matches;
    },    verifyAll(){
      const bad=[];
      for(const item of state.receipts){
        try{if(!verifyDomainVerificationReceipt(item))bad.push(item?.receiptId??String(item?.receiptId));}
        catch{bad.push(item?.receiptId??String(item?.receiptId));}
      }
      return {ok:bad.length===0,checked:state.receipts.length,bad};
    },
  };
  return store;
}
