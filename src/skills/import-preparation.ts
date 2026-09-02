import type { PreparedSkillDocument, SkillSnapshot } from './types.js';
import { chunkSkillMarkdown, MAX_SKILL_CHUNKS } from './chunking.js';
import { skillSourceFailure } from './source/errors.js';

/** Convert a validated, commit-pinned snapshot into bounded memory documents. */
export function documentsFromSkillSnapshot(snapshot: SkillSnapshot): PreparedSkillDocument[] {
  const documents: PreparedSkillDocument[] = [];
  for (const file of snapshot.files) {
    const chunks = chunkSkillMarkdown({
      skillName: snapshot.frontmatter.name,
      sourcePath: file.path,
      markdown: file.content,
      summary: snapshot.frontmatter.description,
      stripFrontmatter: file.primary,
    });
    documents.push(...chunks.map((document) => ({ ...document, primary: file.primary && document.primary })));
    if (documents.length > MAX_SKILL_CHUNKS) skillSourceFailure('skill_too_large');
  }
  return documents;
}
