import type {
  ActionHypothesis,
  AkinatorReasoning,
  ReasoningSiloLevel,
  TaskProfile,
  TaskType,
} from './types.js';

export const AKINATOR_REASONING_POLICY_VERSION = 'reasoning-v1' as const;

const ACTION_FAMILIES: Readonly<Record<TaskType, Omit<ActionHypothesis, 'status'>>> = {
  build: {
    id: 'build',
    label: '実装する',
    description: '対象を変更し、要求された振る舞いを追加する。',
  },
  debug: {
    id: 'debug',
    label: '原因を特定して修正する',
    description: '再現条件と根本原因を絞り、回帰を防ぐ修正を行う。',
  },
  research: {
    id: 'research',
    label: '調査して比較する',
    description: '一次情報と現在の証拠を集め、選択肢を比較する。',
  },
  review: {
    id: 'review',
    label: '検査して指摘する',
    description: '対象を変更せず、欠陥・リスク・不足を証拠付きで示す。',
  },
  devops: {
    id: 'devops',
    label: '運用状態を変更する',
    description: '環境・配備・運用設定を安全に変更して確認する。',
  },
  writing: {
    id: 'writing',
    label: '利用可能な文書を作る',
    description: '対象読者と用途に合う文書を作成または更新する。',
  },
  analysis: {
    id: 'analysis',
    label: '分析して判断材料を作る',
    description: '入力を構造化し、関係・傾向・判断根拠を明らかにする。',
  },
};

function actionFor(profile: TaskProfile): string | null {
  if (profile.taskType === null || profile.target === null || profile.expected === null) return null;
  const family = ACTION_FAMILIES[profile.taskType];
  return `${profile.target}について「${family.label}」を実行し、${profile.expected}を満たす。`;
}

function level(level: ReasoningSiloLevel['level'], value: string | null): ReasoningSiloLevel {
  return { level, status: value === null ? 'missing' : 'resolved', value };
}

export function deriveAkinatorReasoning(task: string, profile: TaskProfile): AkinatorReasoning {
  const selectedAction = actionFor(profile);
  const hypotheses = (Object.keys(ACTION_FAMILIES) as TaskType[]).map((id): ActionHypothesis => ({
    ...ACTION_FAMILIES[id],
    status: profile.taskType === null ? 'possible' : profile.taskType === id ? 'selected' : 'rejected',
  }));
  const verification = profile.expected === null ? [] : [`成功条件を現在の対象で確認する: ${profile.expected}`];
  const stopConditions = [
    ...(profile.expected === null ? [] : [`成功条件を満たした時点で停止する: ${profile.expected}`]),
    ...(profile.constraints === null ? [] : [`制約に抵触する場合は停止して確認する: ${profile.constraints}`]),
  ];
  const levels = [
    level('intent', task.trim() || null),
    level('action-family', profile.taskType === null ? null : ACTION_FAMILIES[profile.taskType].label),
    level('target', profile.target),
    level('success', profile.expected),
    level('action', selectedAction),
    level('verification', verification[0] ?? null),
  ];
  const resolved = levels.filter((item) => item.status === 'resolved').length;
  const stage = profile.taskType === null
    ? 'exploring'
    : selectedAction === null
      ? 'narrowing'
      : 'actionable';
  return {
    policyVersion: AKINATOR_REASONING_POLICY_VERSION,
    stage,
    hypotheses,
    questions: (['taskType', 'target', 'expected'] as const).map((id) => ({
      id,
      status: profile[id] === null ? 'pending' : 'answered',
      ...reasoningQuestionGuidance(id),
    })),
    selectedAction,
    conditions: profile.constraints === null ? [] : [profile.constraints],
    verification,
    stopConditions,
    silo: {
      levels,
      resolved,
      total: levels.length,
      completeness: Number((resolved / levels.length).toFixed(3)),
    },
  };
}

export function reasoningQuestionGuidance(questionId: keyof TaskProfile): { purpose: string; discriminates: string[] } {
  if (questionId === 'taskType') {
    return {
      purpose: '抽象的な依頼を、実装・修正・調査・レビューなどの行動系列へ絞り込みます。',
      discriminates: Object.keys(ACTION_FAMILIES),
    };
  }
  if (questionId === 'target') {
    return {
      purpose: '選ばれた行動系列を、実際に操作または評価する対象へ結び付けます。',
      discriminates: ['対象範囲', '変更境界', '証拠の取得場所'],
    };
  }
  if (questionId === 'expected') {
    return {
      purpose: '作業をした事実ではなく、採用する行動と停止条件を判定できる成功状態へ絞り込みます。',
      discriminates: ['成功条件', '検証方法', '停止条件'],
    };
  }
  return {
    purpose: '実行可能な行動から、許容できない経路と停止すべき条件を除外します。',
    discriminates: ['制約', '除外条件', '停止条件'],
  };
}
