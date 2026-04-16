const EXPLICIT_MEMORY_PATTERNS = [/记住/u, /别忘/u, /记下来/u, /记一下/u];
const PREFERENCE_PATTERNS = [/我喜欢/u, /我爱玩/u, /我常用/u, /我一般/u, /我偏好/u];
const CORRECTION_PATTERNS = [/不是.+是/u, /你记错/u, /更正/u, /纠正/u, /之前说错/u];
const STABLE_RULE_PATTERNS = [
  /统一/u,
  /约定/u,
  /规范/u,
  /习惯/u,
  /长期/u,
  /以后回答/u,
  /默认/u,
  /以后都按/u,
  /固定用/u
];
const DURABLE_FACT_PATTERNS = [
  /我在用/u,
  /我用的是/u,
  /我的系统/u,
  /我的环境/u,
  /我的工作区/u,
  /我的目录/u,
  /我的项目/u,
  /我的习惯/u,
  /平时都用/u
];
const TEMPORARY_PATTERNS = [
  /这次先/u,
  /临时/u,
  /当前先/u,
  /这一步/u,
  /这一轮/u,
  /这轮/u,
  /先这样/u,
  /先别/u,
  /暂时/u,
  /今天先/u,
  /这次报错/u,
  /这个报错/u
];
const SHORT_LIVED_TASK_PATTERNS = [
  /运行一下/u,
  /帮我执行/u,
  /帮我测试/u,
  /帮我调试/u,
  /改这个 bug/u,
  /修这个报错/u,
  /跑一下/u
];

function countMatches(text, patterns) {
  return patterns.reduce((total, pattern) => (pattern.test(text) ? total + 1 : total), 0);
}

function collectRecentUserTexts(scope, maxTurns = 3) {
  const recentTurns = Array.isArray(scope?.recentTurns) ? scope.recentTurns : [];
  return recentTurns
    .slice(-maxTurns)
    .map((turn) => String(turn?.userText ?? "").trim())
    .filter(Boolean);
}

function buildSignalStats(text) {
  return {
    explicit: countMatches(text, EXPLICIT_MEMORY_PATTERNS),
    preference: countMatches(text, PREFERENCE_PATTERNS),
    correction: countMatches(text, CORRECTION_PATTERNS),
    stableRule: countMatches(text, STABLE_RULE_PATTERNS),
    durableFact: countMatches(text, DURABLE_FACT_PATTERNS),
    temporary: countMatches(text, TEMPORARY_PATTERNS),
    shortLivedTask: countMatches(text, SHORT_LIVED_TASK_PATTERNS)
  };
}

function hasPriorStableEvidence(scope) {
  const previousTexts = collectRecentUserTexts(scope)
    .slice(0, -1)
    .filter(Boolean);

  if (previousTexts.length === 0) {
    return false;
  }

  return previousTexts.some((text) => {
    const stats = buildSignalStats(text);
    return stats.preference > 0 || stats.stableRule > 0 || stats.durableFact > 0;
  });
}

export function analyzeMemoryWriteSignals(scope) {
  const text = String(scope?.currentUserText ?? "").trim();
  if (!text) {
    return {
      text,
      shouldConsider: false,
      vetoed: false,
      score: 0,
      level: "info",
      reasons: [],
      stats: buildSignalStats("")
    };
  }

  const stats = buildSignalStats(text);
  const repeatedStableEvidence = hasPriorStableEvidence(scope);
  const reasons = [];
  let score = 0;

  if (stats.preference > 0) {
    score += stats.preference * 4;
    reasons.push("preference");
  }

  if (stats.correction > 0) {
    score += stats.correction * 4;
    reasons.push("correction");
  }

  if (stats.stableRule > 0) {
    score += stats.stableRule * 3;
    reasons.push("stable_rule");
  }

  if (stats.durableFact > 0) {
    score += stats.durableFact * 3;
    reasons.push("durable_fact");
  }

  if (repeatedStableEvidence && score > 0) {
    score += 2;
    reasons.push("repeated_stable_evidence");
  }

  if (stats.explicit > 0) {
    score += stats.explicit;
    reasons.push("explicit_memory_words");
  }

  const negativeScore = stats.temporary * 4 + stats.shortLivedTask * 4;
  if (negativeScore > 0) {
    score -= negativeScore;
    reasons.push("temporary_or_short_lived");
  }

  const strongStableSignal =
    stats.preference > 0 || stats.correction > 0 || stats.stableRule > 0 || stats.durableFact > 0;
  const weakOnlyExplicit = stats.explicit > 0 && !strongStableSignal;
  const vetoed = negativeScore >= 4 && score < 5;
  const shouldConsider =
    !vetoed &&
    (strongStableSignal ? score >= 3 : weakOnlyExplicit ? false : score >= 5);

  let level = "info";
  if (shouldConsider) {
    level = stats.correction > 0 || stats.preference > 0 ? "strong" : "warning";
  }

  return {
    text,
    shouldConsider,
    vetoed,
    score,
    level,
    reasons,
    repeatedStableEvidence,
    stats
  };
}
