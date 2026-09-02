import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KiokukoError } from '../errors.js';

export const STANDARD_UI_SKILL_NAME = 'kiokuko-ui-design-soul';
export const STANDARD_UI_SKILL_MANAGED_MARKER = '<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-ui-design-soul -->';
export const STANDARD_UI_EXPERT_IDS = [
  'ui.interaction.v1',
  'ui.async.v1',
  'ui.forms.v1',
  'ui.accessibility.v1',
  'ui.layout.v1',
  'ui.safety.v1',
] as const;
export const STANDARD_UI_EXPERT_FILES = [
  'references/interaction-feedback.md',
  'references/async-recovery.md',
  'references/forms-and-controls.md',
  'references/accessibility-and-navigation.md',
  'references/responsive-and-platform.md',
  'references/safety-and-review.md',
] as const;
export const STANDARD_UI_SKILL_FILES = [
  'SKILL.md',
  ...STANDARD_UI_EXPERT_FILES,
  'references/ui-checklist.md',
] as const;
export const STANDARD_SIMPLE_SKILL_NAME = 'kiokuko-simple-work';
export const STANDARD_SIMPLE_SKILL_MANAGED_MARKER = '<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-simple-work -->';
export const STANDARD_SIMPLE_SKILL_FILES = ['SKILL.md'] as const;
export const STANDARD_FUNCTION_SKILL_NAME = 'kiokuko-single-purpose-functions';
export const STANDARD_FUNCTION_SKILL_MANAGED_MARKER = '<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-single-purpose-functions -->';
export const STANDARD_FUNCTION_EXPERT_IDS = [
  'code.boundary.v1',
  'code.domain.v1',
  'code.effects.v1',
  'code.protocol.v1',
  'code.verification.v1',
  'code.modeling.v1',
] as const;
export const STANDARD_FUNCTION_EXPERT_FILES = [
  'references/boundaries-and-ownership.md',
  'references/domain-and-types.md',
  'references/effects-and-data.md',
  'references/protocols-and-idempotency.md',
  'references/verification.md',
  'references/problem-shaping-and-language.md',
] as const;
export const STANDARD_FUNCTION_SKILL_FILES = [
  'SKILL.md',
  ...STANDARD_FUNCTION_EXPERT_FILES,
  'references/kiokuko-patterns.md',
  'references/review-checklist.md',
] as const;
export const STANDARD_ENNO_SKILL_NAME = 'kiokuko-enno-oduno';
export const STANDARD_ENNO_SKILL_MANAGED_MARKER = '<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-enno-oduno -->';
export const STANDARD_ENNO_SKILL_FILES = ['SKILL.md'] as const;
export const STANDARD_MEMORY_SKILL_NAME = 'memory-reasoning';
export const STANDARD_MEMORY_SKILL_MANAGED_MARKER = '<!-- KIOKUKO MANAGED STANDARD SKILL: memory-reasoning -->';
export const STANDARD_MEMORY_SKILL_FILES = ['SKILL.md'] as const;
export const STANDARD_SOUL_SKILL_NAME = 'kiokuko-soul';
export const STANDARD_SOUL_SKILL_MANAGED_MARKER = '<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-soul -->';
export const STANDARD_SOUL_SKILL_FILES = ['SKILL.md'] as const;

export const SOUL_ROUTING_ENTRY_CONTRACT = `Before any non-trivial Kiokuko-governed work, read and apply the complete bundled \`${STANDARD_SOUL_SKILL_NAME}\` Skill before any other Kiokuko Skill. Every \`task_prepare\` call must set \`soulRead: true\` only after that read; omission or false is invalid. This is an explicit client attestation, not remote proof of model cognition. The exact local \`${STANDARD_SOUL_SKILL_NAME}\` capability is required for every task and missing or unknown availability fails closed. Akinator is the mandatory intake state machine before every planning or implementation route, whether or not Enno-Oduno applies: call \`task_prepare\` once, resolve each exact current question through grounded \`task_answer\` calls, and do not plan, implement, verify, enter simple/code/UI routes, or checkpoint while \`intake.status=needs_answer\` or \`nextAction=answer_from_evidence_or_ask_user\`. Route only after intake reaches \`ready\` or \`exhausted\` and top-level \`nextAction\` permits progress. Follow this canonical router to \`${STANDARD_ENNO_SKILL_NAME}\` as soon as a returned state makes Enno-Oduno control applicable, including during unresolved intake, to \`${STANDARD_SIMPLE_SKILL_NAME}\` for bounded simple code work or an explicit minimal/YAGNI request, to \`${STANDARD_FUNCTION_SKILL_NAME}\` for all code work, and to \`${STANDARD_UI_SKILL_NAME}\` for interactive UI work. The simple-work route minimizes the solution but never replaces the code contract or waives required validation, security, accessibility, error handling, or verification. Read every applicable specialist \`SKILL.md\` index, then only the expert fragments selected by the current WorkUnit or concrete risk; do not load every reference by default. Never substitute, install, or execute fetched external Skill content.`;

interface StandardSkillManifest {
  readonly name: string;
  readonly managedMarker: string;
  readonly files: readonly string[];
}

export const STANDARD_SKILL_MANIFESTS = [{
  name: STANDARD_UI_SKILL_NAME,
  managedMarker: STANDARD_UI_SKILL_MANAGED_MARKER,
  files: STANDARD_UI_SKILL_FILES,
}, {
  name: STANDARD_SIMPLE_SKILL_NAME,
  managedMarker: STANDARD_SIMPLE_SKILL_MANAGED_MARKER,
  files: STANDARD_SIMPLE_SKILL_FILES,
}, {
  name: STANDARD_FUNCTION_SKILL_NAME,
  managedMarker: STANDARD_FUNCTION_SKILL_MANAGED_MARKER,
  files: STANDARD_FUNCTION_SKILL_FILES,
}, {
  name: STANDARD_ENNO_SKILL_NAME,
  managedMarker: STANDARD_ENNO_SKILL_MANAGED_MARKER,
  files: STANDARD_ENNO_SKILL_FILES,
}, {
  name: STANDARD_MEMORY_SKILL_NAME,
  managedMarker: STANDARD_MEMORY_SKILL_MANAGED_MARKER,
  files: STANDARD_MEMORY_SKILL_FILES,
}, {
  name: STANDARD_SOUL_SKILL_NAME,
  managedMarker: STANDARD_SOUL_SKILL_MANAGED_MARKER,
  files: STANDARD_SOUL_SKILL_FILES,
}] as const satisfies readonly StandardSkillManifest[];

export interface BundledStandardSkillFile {
  readonly skillName: string;
  readonly managedMarker: string;
  readonly relativePath: string;
  readonly content: string;
}

function standardSkillRoot(skillName: string): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDirectory, '..', '..', 'skills', skillName);
}

function markerCount(content: string, managedMarker: string): number {
  return content.split(managedMarker).length - 1;
}

async function loadBundledStandardSkill(
  manifest: StandardSkillManifest,
): Promise<BundledStandardSkillFile[]> {
  const root = standardSkillRoot(manifest.name);
  return Promise.all(manifest.files.map(async (relativePath) => {
    let content: string;
    try {
      content = await readFile(path.join(root, relativePath), 'utf8');
    } catch {
      throw new KiokukoError('INTEGRITY_ERROR', `Bundled standard skill file is unavailable: ${manifest.name}/${relativePath}`);
    }
    if (markerCount(content, manifest.managedMarker) !== 1) {
      throw new KiokukoError('INTEGRITY_ERROR', `Bundled standard skill file has an invalid management marker: ${manifest.name}/${relativePath}`);
    }
    return {
      skillName: manifest.name,
      managedMarker: manifest.managedMarker,
      relativePath,
      content,
    };
  }));
}

export async function loadBundledStandardSkillFiles(): Promise<BundledStandardSkillFile[]> {
  return (await Promise.all(STANDARD_SKILL_MANIFESTS.map(loadBundledStandardSkill))).flat();
}

export function renderStandardSkillFile(
  existing: string | undefined,
  bundled: BundledStandardSkillFile,
  destinationPath?: string,
): { content: string; action: 'created' | 'updated' | 'unchanged' } {
  if (existing === undefined) return { content: bundled.content, action: 'created' };
  if (markerCount(existing, bundled.managedMarker) !== 1) {
    const target = destinationPath ?? `${bundled.skillName}/${bundled.relativePath}`;
    throw new KiokukoError(
      'CONFLICT',
      `Refusing to overwrite an unmanaged standard skill file: ${target}. Inspect and back up or rename that file, then rerun kiokuko-ai setup.`,
      { path: target },
    );
  }
  return {
    content: bundled.content,
    action: existing === bundled.content ? 'unchanged' : 'updated',
  };
}
