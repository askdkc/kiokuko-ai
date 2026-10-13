import { writeFileSync } from 'node:fs';
export function completeVerification(evidence = {}) {
  if (!process.env.KIOKUKO_VERIFY_COMPLETION_FILE || process.exitCode && process.exitCode !== 0) return;
  const {KIOKUKO_VERIFY_CHECK_ID:id,KIOKUKO_VERIFY_NONCE:nonce}=process.env;
  if (!id || !nonce) throw new Error('Missing verification completion identity');
  writeFileSync(process.env.KIOKUKO_VERIFY_COMPLETION_FILE,JSON.stringify({schema:'verification-completion-v1',id,nonce,status:'passed',evidence}),{flag:'wx'});
}
export function validCompletion(value, id, nonce, required = {}) {
  return !!(value?.schema === 'verification-completion-v1' && value.id === id && value.nonce === nonce && value.status === 'passed'
    && value.evidence && typeof value.evidence === 'object' && !Array.isArray(value.evidence)
    && Object.entries(required).every(([key,expected])=>value.evidence[key]===expected));
}
