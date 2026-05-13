const DEFAULT_MAX_RECALLED_NODES = 3;
const DEFAULT_MAX_SOURCE_USER_MESSAGES = 2;
const DEFAULT_MIN_SCORE = 8;
const MIN_TOKEN_LENGTH = 2;
const MAX_EXPLANATION_CHARS = 280;
const RELATED_NODE_PREVIEW_RECALL_SCORE = 8;
const MAX_RECALL_RELATED_NODE_PREVIEW_CANDIDATES = 1;
const MAX_RECALL_RELATED_NODE_PREVIEW_ITEMS = 3;

const STOPWORD_SET = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "been",
  "for",
  "from",
  "in",
  "into",
  "is",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "these",
  "this",
  "those",
  "to",
  "was",
  "were",
  "with",
  "一个",
  "一些",
  "这个",
  "那个",
  "这里",
  "那里"
]);

const KEYWORD_SCORE_CONFIG = {
  specific: {
    exactWeight: 10,
    partialWeight: 4
  },
  general: {
    exactWeight: 4,
    partialWeight: 1
  }
};

const FIELD_SIMILARITY_CONFIG = {
  coreWeight: 0.8,
  explanationWeight: 0.2,
  boostWeight: 8
};

const PREFERENCE_QUERY_PATTERNS = [
  /我.*(喜欢|爱玩|常玩|爱好|偏好|常用|爱用|习惯|偏向|倾向).*(什么|哪些|哪种|哪类)?/u,
  /我.*什么(游戏|风格|语言|工具|框架|编辑器|口味|音乐|歌|平台)/u,
  /还记得我.*(喜欢|爱玩|常玩|爱好|偏好|常用|爱用|习惯|偏向|倾向)/u
];

const PREFERENCE_CONTAINER_HINTS = [
  "偏好",
  "喜好",
  "爱好",
  "习惯"
];

const PREFERENCE_NODE_HINTS = [
  "偏好",
  "喜好",
  "喜欢",
  "爱好",
  "习惯",
  "常用",
  "爱用",
  "爱玩",
  "常玩",
  "风格",
  "口味",
  "偏向",
  "倾向"
];

const PREFERENCE_NEGATION_PATTERN =
  /不是.*(偏好|喜好|喜欢|爱好|习惯|常用|爱用|爱玩|常玩|风格|口味|偏向|倾向)/u;

function normalizeOptionalText(value) {
  return String(value ?? "").trim();
}

function normalizeForMatching(value) {
  return normalizeOptionalText(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{Script=Han}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeNormalizedText(value) {
  const normalized = normalizeForMatching(value);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= MIN_TOKEN_LENGTH && !STOPWORD_SET.has(token));
}

function classifySparseChar(char) {
  if (/[\p{Script=Han}]/u.test(char)) {
    return "han";
  }
  if (/[\p{L}]/u.test(char)) {
    return "letter";
  }
  if (/[\p{N}]/u.test(char)) {
    return "number";
  }
  return "separator";
}

function splitSparseSegments(value) {
  const normalized = normalizeForMatching(value);
  const segments = [];
  let currentType = "";
  let currentText = "";

  for (const char of Array.from(normalized)) {
    const type = classifySparseChar(char);
    if (type === "separator") {
      if (currentText) {
        segments.push({ type: currentType, text: currentText });
      }
      currentType = "";
      currentText = "";
      continue;
    }

    if (currentText && type !== currentType) {
      segments.push({ type: currentType, text: currentText });
      currentText = "";
    }

    currentType = type;
    currentText += char;
  }

  if (currentText) {
    segments.push({ type: currentType, text: currentText });
  }

  return segments;
}

function tokenizeSparseTerms(value) {
  const terms = [];

  for (const segment of splitSparseSegments(value)) {
    const chars = Array.from(segment.text);
    if (segment.type === "han") {
      if (chars.length < 2) {
        continue;
      }
      for (let index = 0; index <= chars.length - 2; index += 1) {
        terms.push(chars.slice(index, index + 2).join(""));
      }
      continue;
    }

    if (segment.text.length >= MIN_TOKEN_LENGTH && !STOPWORD_SET.has(segment.text)) {
      terms.push(segment.text);
    }
  }

  return terms;
}

function buildSparseTermSet(value) {
  return new Set(tokenizeSparseTerms(value));
}

function calculateBinaryCosineSimilarity(leftTerms, rightTerms) {
  if (!(leftTerms instanceof Set) || !(rightTerms instanceof Set)) {
    return 0;
  }
  if (leftTerms.size === 0 || rightTerms.size === 0) {
    return 0;
  }

  let intersectionCount = 0;
  const [smaller, larger] =
    leftTerms.size <= rightTerms.size ? [leftTerms, rightTerms] : [rightTerms, leftTerms];
  for (const term of smaller) {
    if (larger.has(term)) {
      intersectionCount += 1;
    }
  }

  if (intersectionCount === 0) {
    return 0;
  }

  return intersectionCount / Math.sqrt(leftTerms.size * rightTerms.size);
}

function scoreFieldSimilarity(preparedNode, input) {
  const queryTerms = input?.sparseTermSet instanceof Set ? input.sparseTermSet : new Set();
  const coreSimilarity = calculateBinaryCosineSimilarity(
    queryTerms,
    preparedNode?.coreMemoryTermSet
  );
  const explanationSimilarity = calculateBinaryCosineSimilarity(
    queryTerms,
    preparedNode?.explanationTermSet
  );
  const similarity =
    coreSimilarity * FIELD_SIMILARITY_CONFIG.coreWeight +
    explanationSimilarity * FIELD_SIMILARITY_CONFIG.explanationWeight;
  const boost = similarity * FIELD_SIMILARITY_CONFIG.boostWeight;

  return {
    score: boost,
    similarity,
    coreSimilarity,
    explanationSimilarity,
    boost
  };
}

function normalizeKeywordPhrase(value) {
  const normalized = normalizeForMatching(value);
  if (!normalized) {
    return "";
  }

  const compact = normalized.replace(/\s+/g, " ").trim();
  if (compact.length < MIN_TOKEN_LENGTH || STOPWORD_SET.has(compact)) {
    return "";
  }

  return compact;
}

function normalizeKeywordEntries(values = []) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((keyword) => {
      const raw = normalizeOptionalText(keyword);
      const phrase = normalizeKeywordPhrase(keyword);
      if (!raw || !phrase) {
        return null;
      }

      return {
        raw,
        phrase,
        tokens: tokenizeNormalizedText(phrase)
      };
    })
    .filter(Boolean);
}

function clipText(value, maxChars) {
  const normalized = normalizeOptionalText(value);
  if (!normalized || normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function countTokenMatches(tokens, tokenSet) {
  let count = 0;
  for (const token of tokens) {
    if (tokenSet.has(token)) {
      count += 1;
    }
  }
  return count;
}

function isPreferenceQuery(input) {
  const normalizedText = normalizeOptionalText(input?.normalizedText);
  if (!normalizedText) {
    return false;
  }

  return PREFERENCE_QUERY_PATTERNS.some((pattern) => pattern.test(normalizedText));
}

function isPreferenceLikeNode(preparedNode) {
  const hierarchyText = normalizeForMatching([
    preparedNode?.topicName,
    preparedNode?.contentName
  ].join(" "));
  if (hierarchyText && PREFERENCE_CONTAINER_HINTS.some((hint) => hierarchyText.includes(hint))) {
    return true;
  }

  const searchText = normalizeForMatching([
    preparedNode?.name,
    preparedNode?.coreMemory,
    preparedNode?.explanation,
    ...(preparedNode?.specificKeywords ?? []).map((keyword) => keyword.raw),
    ...(preparedNode?.generalKeywords ?? []).map((keyword) => keyword.raw)
  ].join(" "));

  if (!searchText) {
    return false;
  }

  if (PREFERENCE_NEGATION_PATTERN.test(searchText)) {
    return false;
  }

  return PREFERENCE_NODE_HINTS.some((hint) => searchText.includes(hint));
}

function dedupeRankedMatches(matches = []) {
  const selected = [];
  const seenKeys = new Set();

  for (const match of matches) {
    const dedupeKeys = [
      normalizeForMatching(match?.node?.name),
      normalizeForMatching(match?.node?.coreMemory)
    ].filter(Boolean);

    if (dedupeKeys.some((key) => seenKeys.has(key))) {
      continue;
    }

    for (const key of dedupeKeys) {
      seenKeys.add(key);
    }
    selected.push(match);
  }

  return selected;
}

function buildInputFromMessages(messages = [], maxSourceUserMessages = DEFAULT_MAX_SOURCE_USER_MESSAGES) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      messageCount: 0,
      text: "",
      normalizedText: "",
      tokens: [],
      tokenSet: new Set(),
      sparseTermSet: new Set()
    };
  }

  const selected = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (String(message?.role ?? "").trim() !== "user") {
      continue;
    }

    const content = normalizeOptionalText(message?.content);
    if (!content) {
      continue;
    }

    selected.push(content);
    if (selected.length >= maxSourceUserMessages) {
      break;
    }
  }

  const ordered = selected.reverse();
  const text = ordered.join("\n");
  const normalizedText = normalizeForMatching(text);
  const tokens = tokenizeNormalizedText(text);

  return {
    messageCount: ordered.length,
    text,
    normalizedText,
    tokens,
    tokenSet: new Set(tokens),
    sparseTermSet: buildSparseTermSet(text)
  };
}

function buildMemoryContextBlock(matches = []) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return "";
  }

  const lines = [
    "<long-term-memory>",
    "[System note: The following is recalled long-term memory, not new user input. Use it only as background context when directly relevant.]"
  ];

  for (const [index, match] of matches.entries()) {
    const node = match?.node ?? {};
    lines.push("");
    lines.push(`[${index + 1}]`);
    lines.push(`Topic: ${normalizeOptionalText(node.topicName) || "未分类主题"}`);
    lines.push(`Content: ${normalizeOptionalText(node.contentName) || "未分类内容"}`);
    lines.push(`Node: ${normalizeOptionalText(node.name) || "未命名记忆"}`);
    lines.push(`Core memory: ${normalizeOptionalText(node.coreMemory)}`);

    const explanation = clipText(node.explanation, MAX_EXPLANATION_CHARS);
    if (explanation) {
      lines.push(`Explanation: ${explanation}`);
    }

    const matchedSpecificKeywords = Array.isArray(match?.matchedSpecificKeywords)
      ? match.matchedSpecificKeywords.map((item) => normalizeOptionalText(item)).filter(Boolean)
      : [];
    const matchedGeneralKeywords = Array.isArray(match?.matchedGeneralKeywords)
      ? match.matchedGeneralKeywords.map((item) => normalizeOptionalText(item)).filter(Boolean)
      : [];

    if (matchedSpecificKeywords.length > 0) {
      lines.push(`Matched specific keywords: ${matchedSpecificKeywords.join(", ")}`);
    }

    if (matchedGeneralKeywords.length > 0) {
      lines.push(`Matched general keywords: ${matchedGeneralKeywords.join(", ")}`);
    }

    const relatedMemoryNodes = Array.isArray(match?.relatedMemoryNodes)
      ? match.relatedMemoryNodes
      : [];
    if (relatedMemoryNodes.length > 0) {
      lines.push("Related memory nodes:");
      for (const relatedNode of relatedMemoryNodes) {
        const relatedTopicName = normalizeOptionalText(relatedNode?.topicName) || "未分类主题";
        const relatedContentName =
          normalizeOptionalText(relatedNode?.contentName) || "未分类内容";
        const relatedNodeName = normalizeOptionalText(relatedNode?.memoryNodeName) || "未命名记忆";
        const relationType = normalizeOptionalText(relatedNode?.relationType) || "related_to";
        lines.push(
          `- ${relatedNodeName} (${relatedTopicName} / ${relatedContentName}, relation: ${relationType})`
        );
      }
    }
  }

  lines.push("</long-term-memory>");
  return lines.join("\n");
}

function scoreKeywordEntries(preparedNode, entries, input, config) {
  let exactHits = 0;
  let partialHits = 0;
  const matchedKeywords = [];

  for (const keyword of entries) {
    const exactMatched = input.normalizedText.includes(keyword.phrase);
    if (exactMatched) {
      exactHits += 1;
      matchedKeywords.push(keyword.raw);
      continue;
    }

    if (keyword.tokens.length < 2) {
      continue;
    }

    const matchedTokenCount = countTokenMatches(keyword.tokens, input.tokenSet);
    if (matchedTokenCount < 2) {
      continue;
    }

    partialHits += matchedTokenCount;
    matchedKeywords.push(keyword.raw);
  }

  const uniqueMatchedKeywords = Array.from(new Set(matchedKeywords));
  const score = exactHits * config.exactWeight + partialHits * config.partialWeight;

  return {
    score,
    exactHits,
    partialHits,
    matchedKeywordCount: uniqueMatchedKeywords.length,
    matchedKeywords: uniqueMatchedKeywords
  };
}

export class LongTermMemoryRecallService {
  constructor(options = {}) {
    this.memoryStore = options.memoryStore ?? null;
    this.maxRecalledNodes = Number.isInteger(options.maxRecalledNodes)
      ? Math.max(1, options.maxRecalledNodes)
      : DEFAULT_MAX_RECALLED_NODES;
    this.maxSourceUserMessages = Number.isInteger(options.maxSourceUserMessages)
      ? Math.max(1, options.maxSourceUserMessages)
      : DEFAULT_MAX_SOURCE_USER_MESSAGES;
    this.minScore = Number.isFinite(Number(options.minScore))
      ? Math.max(1, Math.trunc(Number(options.minScore)))
      : DEFAULT_MIN_SCORE;
    this.cachedRevision = null;
    this.cachedIndex = {
      preparedNodes: [],
      phraseIndexes: {
        specific: new Map(),
        general: new Map()
      },
      tokenIndexes: {
        specific: new Map(),
        general: new Map()
      }
    };
  }

  ensureMemoryStore(memoryStoreOverride = null) {
    const memoryStore = memoryStoreOverride ?? this.memoryStore;
    if (!memoryStore || typeof memoryStore.listAllNodes !== "function") {
      throw new Error("long-term memory recall service requires a memoryStore");
    }
    return memoryStore;
  }

  addKeywordEntriesToIndex(indexMap, entries, nodeId, selector) {
    for (const keyword of entries) {
      const values = selector(keyword);
      for (const value of values) {
        if (!indexMap.has(value)) {
          indexMap.set(value, new Set());
        }
        indexMap.get(value).add(nodeId);
      }
    }
  }

  getPreparedIndex(memoryStoreOverride = null) {
    const memoryStore = this.ensureMemoryStore(memoryStoreOverride);
    const revision =
      typeof memoryStore.getRevision === "function"
        ? memoryStore.getRevision()
        : null;

    if (this.cachedRevision !== null && revision !== null && this.cachedRevision === revision) {
      return this.cachedIndex;
    }

    const preparedNodes = memoryStore
      .listAllNodes()
      .map((node) => this.prepareNode(node))
      .filter(Boolean);

    const phraseIndexes = {
      specific: new Map(),
      general: new Map()
    };
    const tokenIndexes = {
      specific: new Map(),
      general: new Map()
    };

    for (const preparedNode of preparedNodes) {
      this.addKeywordEntriesToIndex(
        phraseIndexes.specific,
        preparedNode.specificKeywords,
        preparedNode.id,
        (keyword) => [keyword.phrase]
      );
      this.addKeywordEntriesToIndex(
        phraseIndexes.general,
        preparedNode.generalKeywords,
        preparedNode.id,
        (keyword) => [keyword.phrase]
      );
      this.addKeywordEntriesToIndex(
        tokenIndexes.specific,
        preparedNode.specificKeywords,
        preparedNode.id,
        (keyword) => keyword.tokens
      );
      this.addKeywordEntriesToIndex(
        tokenIndexes.general,
        preparedNode.generalKeywords,
        preparedNode.id,
        (keyword) => keyword.tokens
      );
    }

    this.cachedRevision = revision;
    this.cachedIndex = {
      preparedNodes,
      phraseIndexes,
      tokenIndexes
    };

    return this.cachedIndex;
  }

  prepareNode(node) {
    if (!node?.id) {
      return null;
    }

    const normalizedSpecificKeywords = normalizeKeywordEntries(node.specificKeywords);
    const normalizedGeneralKeywords = normalizeKeywordEntries(node.generalKeywords);

    if (normalizedSpecificKeywords.length === 0 && normalizedGeneralKeywords.length === 0) {
      return null;
    }

    return {
      id: String(node.id),
      topicId: String(node.topicId ?? "").trim(),
      topicName: normalizeOptionalText(node.topicName),
      contentId: String(node.contentId ?? "").trim(),
      contentName: normalizeOptionalText(node.contentName),
      name: normalizeOptionalText(node.name),
      coreMemory: normalizeOptionalText(node.coreMemory),
      explanation: normalizeOptionalText(node.explanation),
      updatedAt: normalizeOptionalText(node.updatedAt),
      normalizedName: normalizeForMatching(node.name),
      normalizedCoreMemory: normalizeForMatching(node.coreMemory),
      normalizedExplanation: normalizeForMatching(node.explanation),
      coreMemoryTermSet: buildSparseTermSet(node.coreMemory),
      explanationTermSet: buildSparseTermSet(node.explanation),
      specificKeywords: normalizedSpecificKeywords,
      generalKeywords: normalizedGeneralKeywords
    };
  }

  buildRelatedMemoryNodePreview(nodeId, memoryStoreOverride = null) {
    const memoryStore = this.ensureMemoryStore(memoryStoreOverride);
    if (!nodeId || typeof memoryStore.listNodeRelations !== "function") {
      return [];
    }

    return memoryStore
      .listNodeRelations(nodeId)
      .slice(0, MAX_RECALL_RELATED_NODE_PREVIEW_ITEMS);
  }

  collectCandidateNodeIds(input, index) {
    const candidateIds = new Set();

    for (const phraseIndex of Object.values(index.phraseIndexes)) {
      for (const [phrase, nodeIds] of phraseIndex.entries()) {
        if (!input.normalizedText.includes(phrase)) {
          continue;
        }

        for (const nodeId of nodeIds) {
          candidateIds.add(nodeId);
        }
      }
    }

    for (const tokenIndex of Object.values(index.tokenIndexes)) {
      for (const token of input.tokenSet) {
        const nodeIds = tokenIndex.get(token);
        if (!nodeIds) {
          continue;
        }

        for (const nodeId of nodeIds) {
          candidateIds.add(nodeId);
        }
      }
    }

    return candidateIds;
  }

  scoreCandidateNode(preparedNode, input) {
    const preferenceQuery = isPreferenceQuery(input);
    const preferenceLikeNode = isPreferenceLikeNode(preparedNode);
    const specificStats = scoreKeywordEntries(
      preparedNode,
      preparedNode.specificKeywords,
      input,
      KEYWORD_SCORE_CONFIG.specific
    );
    const generalStats = scoreKeywordEntries(
      preparedNode,
      preparedNode.generalKeywords,
      input,
      KEYWORD_SCORE_CONFIG.general
    );

    const matchedSpecificKeywords = specificStats.matchedKeywords;
    const matchedGeneralKeywords = generalStats.matchedKeywords;
    const matchedKeywords = Array.from(
      new Set([...matchedSpecificKeywords, ...matchedGeneralKeywords])
    );
    const fieldSimilarityStats = scoreFieldSimilarity(preparedNode, input);
    const preferenceQueryBoost =
      preferenceQuery && preferenceLikeNode && generalStats.exactHits >= 1 ? 3 : 0;
    const score =
      specificStats.score + generalStats.score + preferenceQueryBoost + fieldSimilarityStats.score;
    const qualifiesByPreferenceGeneral =
      preferenceQuery &&
      preferenceLikeNode &&
      generalStats.exactHits >= 1 &&
      score >= Math.max(KEYWORD_SCORE_CONFIG.general.exactWeight, this.minScore - 4);
    const qualifies =
      specificStats.exactHits >= 1 ||
      (specificStats.matchedKeywordCount >= 1 && score >= this.minScore) ||
      (generalStats.exactHits >= 2 && score >= this.minScore) ||
      qualifiesByPreferenceGeneral ||
      (matchedKeywords.length >= 3 && score >= this.minScore + 1);

    if (!qualifies) {
      return null;
    }

    return {
      node: {
        id: preparedNode.id,
        topicId: preparedNode.topicId,
        topicName: preparedNode.topicName,
        contentId: preparedNode.contentId,
        contentName: preparedNode.contentName,
        name: preparedNode.name,
        coreMemory: preparedNode.coreMemory,
        explanation: preparedNode.explanation,
        updatedAt: preparedNode.updatedAt
      },
      score,
      matchedKeywordCount: matchedKeywords.length,
      matchedKeywords,
      matchedSpecificKeywords,
      matchedGeneralKeywords,
      debugScores: {
        specific: specificStats,
        general: generalStats,
        fieldSimilarity: fieldSimilarityStats,
        preferenceQuery,
        preferenceLikeNode,
        preferenceQueryBoost
      }
    };
  }

  recallFromConversationMessages(messages = [], memoryStoreOverride = null) {
    const input = buildInputFromMessages(messages, this.maxSourceUserMessages);
    if (!input.normalizedText) {
      return {
        shouldRecall: false,
        input,
        recalledNodes: [],
        memoryContextBlock: "",
        debugMeta: {
          candidateCount: 0,
          selectedCount: 0
        }
      };
    }

    const index = this.getPreparedIndex(memoryStoreOverride);
    const candidateIds = this.collectCandidateNodeIds(input, index);

    if (candidateIds.size === 0) {
      return {
        shouldRecall: false,
        input,
        recalledNodes: [],
        memoryContextBlock: "",
        debugMeta: {
          candidateCount: 0,
          selectedCount: 0
        }
      };
    }

    const preparedNodeMap = new Map(index.preparedNodes.map((node) => [node.id, node]));
    const rankedMatches = [];

    for (const candidateId of candidateIds) {
      const preparedNode = preparedNodeMap.get(candidateId);
      if (!preparedNode) {
        continue;
      }

      const scored = this.scoreCandidateNode(preparedNode, input);
      if (scored) {
        rankedMatches.push(scored);
      }
    }

    rankedMatches.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.matchedKeywordCount !== left.matchedKeywordCount) {
        return right.matchedKeywordCount - left.matchedKeywordCount;
      }
      return String(right.node.updatedAt).localeCompare(String(left.node.updatedAt));
    });

    const deduped = dedupeRankedMatches(rankedMatches).slice(0, this.maxRecalledNodes);
    const enrichedMatches = deduped.map((match, index) => {
      if (
        index >= MAX_RECALL_RELATED_NODE_PREVIEW_CANDIDATES ||
        Number(match?.score ?? 0) < RELATED_NODE_PREVIEW_RECALL_SCORE
      ) {
        return match;
      }

      return {
        ...match,
        relatedMemoryNodes: this.buildRelatedMemoryNodePreview(
          match?.node?.id,
          memoryStoreOverride
        )
      };
    });
    const memoryContextBlock = buildMemoryContextBlock(enrichedMatches);

    return {
      shouldRecall: enrichedMatches.length > 0,
      input,
      recalledNodes: enrichedMatches,
      memoryContextBlock,
      debugMeta: {
        candidateCount: candidateIds.size,
        selectedCount: enrichedMatches.length
      }
    };
  }
}

export { buildMemoryContextBlock };
