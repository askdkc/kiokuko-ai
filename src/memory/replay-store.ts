import type { SqliteDatabase } from '../db/adapter.js';
import { databaseFileIdentity, openConnection } from '../db/connection.js';
import { withImmediateTransaction, TransactionCommitUncertainError } from '../db/transaction.js';
import { parseRetrievalQuery } from './retrieval-query.js';
import { findSecretInValue } from './secrets.js';
import { proposalDigest, type ReplayMemoryProposal } from './replay-review.js';

/** Call only from a trusted review adapter's save closure. This is not a model API. */
export function createApprovedReplayMemoryStore(db: SqliteDatabase, workspace: string,
  indexApproved?: (proposal: ReplayMemoryProposal, approvalKey: string) => {id:string;revision:number} | void) {
  const fileIdentity = db.filePath === ':memory:' ? undefined : databaseFileIdentity(db.filePath);
  function reconcile(proposal: ReplayMemoryProposal, approvalKey: string): 'saved' | 'unavailable' {
    if (!fileIdentity || proposal.source.workspace !== workspace || !/^[a-f0-9]{64}$/u.test(approvalKey)) return 'unavailable';
    let independent: SqliteDatabase | undefined;
    try {
      independent = openConnection(db.filePath, { readOnly: true, expectedFileIdentity: fileIdentity });
      const receipt = independent.prepare('SELECT digest,workspace FROM replay_memory_receipts WHERE approval_key=?').get<{digest:string;workspace:string}>(approvalKey);
      return receipt?.digest === proposalDigest(proposal) && receipt.workspace === workspace ? 'saved' : 'unavailable';
    } catch { return 'unavailable'; }
    finally { independent?.close(); }
  }
  return {
    // Reconciliation never writes or generates another approval identity.
    reconcile,
    save(proposal: ReplayMemoryProposal, approvalKey: string): void {
      const owned = structuredClone(proposal), digest = proposalDigest(owned);
      const contentHash=proposalDigest({...owned,proposalId:"",revision:0});
      if (owned.source.workspace !== workspace || owned.schemaVersion !== 1 || owned.revision < 1
        || !/^[a-f0-9]{64}$/u.test(approvalKey) || findSecretInValue(owned)
        || Buffer.byteLength(JSON.stringify(owned)) > 256 * 1024) throw new Error('invalid_approved_memory');
      try { withImmediateTransaction(db, () => {
        // Tables and candidate contents are created only after approval. Rollback covers indexing too.
        db.exec(`CREATE TABLE IF NOT EXISTS replay_memories(approval_key TEXT PRIMARY KEY, workspace TEXT NOT NULL, task_id TEXT NOT NULL, session_id TEXT NOT NULL, proposal_id TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL, proposal_json TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS replay_memory_terms(approval_key TEXT NOT NULL REFERENCES replay_memories(approval_key), term TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(approval_key,term,kind));
          CREATE INDEX IF NOT EXISTS replay_memory_terms_lookup ON replay_memory_terms(term);
          CREATE TABLE IF NOT EXISTS replay_memory_receipts(approval_key TEXT PRIMARY KEY,workspace TEXT NOT NULL,digest TEXT NOT NULL,memory_key TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS replay_memory_content(workspace TEXT NOT NULL,content_hash TEXT NOT NULL,memory_key TEXT NOT NULL,PRIMARY KEY(workspace,content_hash));
          CREATE TABLE IF NOT EXISTS replay_memory_entries(memory_key TEXT PRIMARY KEY,entry_id TEXT NOT NULL,entry_revision INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS replay_memory_retired(approval_key TEXT PRIMARY KEY);`);
        if(db.prepare('SELECT 1 FROM replay_memory_retired WHERE approval_key=?').get(approvalKey))throw new Error('approval_retired');
        const prior = db.prepare('SELECT digest,workspace FROM replay_memory_receipts WHERE approval_key=?').get<{digest: string;workspace: string}>(approvalKey);
        if (prior) { if (prior.digest !== digest || prior.workspace !== workspace) throw new Error('approval_key_conflict'); return; }
        const duplicate=db.prepare('SELECT memory_key FROM replay_memory_content WHERE workspace=? AND content_hash=?').get<{memory_key:string}>(workspace,contentHash);
        db.prepare('INSERT INTO replay_memory_receipts VALUES(?,?,?,?)').run(approvalKey,workspace,digest,duplicate?.memory_key??approvalKey);
        if(duplicate)return;
        db.prepare('INSERT INTO replay_memory_content VALUES(?,?,?)').run(workspace,contentHash,approvalKey);
        db.prepare('INSERT INTO replay_memories VALUES(?,?,?,?,?,?,?,?,?)').run(approvalKey, workspace, owned.source.taskId, owned.source.sessionId, owned.proposalId, owned.revision, digest, JSON.stringify(owned), new Date().toISOString());
        for (const [kind, terms] of [['tag', owned.tags], ['keyword', owned.keywords]] as const) {
          for (const term of [...new Set(terms.flatMap(t => { const parsed=parseRetrievalQuery(t); return [t.toLowerCase(),...parsed.lexicalTerms,...parsed.substringTerms]; }).filter(t => t.length > 0 && t.length <= 64))].slice(0,256)) {
            db.prepare('INSERT INTO replay_memory_terms VALUES(?,?,?)').run(approvalKey, term, kind);
          }
        }
        const entry=indexApproved?.(owned, approvalKey);
        if(entry)db.prepare('INSERT INTO replay_memory_entries VALUES(?,?,?)').run(approvalKey,entry.id,entry.revision);
      }); } catch (error) {
        // A lost COMMIT acknowledgment is not permission for another key or another write.
        if (error instanceof TransactionCommitUncertainError) {
          // The writer may still hold an uncommitted transaction. Its own reads prove nothing.
          // Only a separate read-only connection to the same file can establish durability.
          if (reconcile(owned, approvalKey) === 'saved') return;
        }
        throw error;
      }
    },
    query(query: string, tags: string[] = [], limit = 10): ReplayMemoryProposal[] {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='replay_memories'").get()) return [];
      const parsed = parseRetrievalQuery(query);
      const terms = [...new Set([...tags, ...parsed.lexicalTerms, ...parsed.substringTerms].map(t => t.toLowerCase()))].slice(0, 64);
      if (!terms.length) return [];
      const indexed=db.prepare("SELECT 1 FROM sqlite_master WHERE name='entries'").get();
      const live=indexed?"AND NOT EXISTS(SELECT 1 FROM replay_memory_entries r WHERE r.memory_key=m.approval_key AND NOT EXISTS(SELECT 1 FROM entries e WHERE e.id=r.entry_id AND e.current_revision=r.entry_revision AND e.status<>'superseded'))":"";
      const rows = db.prepare(`SELECT m.proposal_json,m.digest,COUNT(DISTINCT t.term) AS score FROM replay_memories m
        JOIN replay_memory_terms t USING(approval_key) WHERE m.workspace=? ${live} AND t.term IN (${terms.map(() => '?').join(',')})
        GROUP BY m.approval_key ORDER BY score DESC,m.created_at DESC LIMIT ?`).all<{proposal_json:string;digest:string}>(workspace, ...terms, Math.max(1, Math.min(50, limit)));
      return rows.flatMap(row => { try { const p = JSON.parse(row.proposal_json) as ReplayMemoryProposal;
        return proposalDigest(p) === row.digest && p.source.workspace === workspace ? [p] : []; } catch { return []; } });
    },
  };
}

/** Called by the existing explicitly-confirmed purge inside its transaction. No content survives. */
export function purgeReplayMemoryForEntryInTransaction(db:SqliteDatabase,entryId:string):void {
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='replay_memory_entries'").get())return;
  const rows=db.prepare('SELECT memory_key FROM replay_memory_entries WHERE entry_id=?').all<{memory_key:string}>(entryId);
  for(const {memory_key:key} of rows){
    db.prepare('INSERT OR IGNORE INTO replay_memory_retired SELECT approval_key FROM replay_memory_receipts WHERE memory_key=?').run(key);
    for(const table of ['replay_memory_receipts','replay_memory_content','replay_memory_entries'])db.prepare(`DELETE FROM ${table} WHERE memory_key=?`).run(key);
    db.prepare('DELETE FROM replay_memory_terms WHERE approval_key=?').run(key);
    db.prepare('DELETE FROM replay_memories WHERE approval_key=?').run(key);
  }
}
