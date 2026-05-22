const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function loadJsonConfig(filename, fallback) {
  try {
    const configPath = path.join(__dirname, "..", "config", filename);
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

const FLOW_STEPS = [
  { id: "role", title: "角色与背景", description: "确定业务身份与任务语境" },
  { id: "target", title: "抽取目标", description: "确认本次要抽取的词条范围" },
  { id: "synonym", title: "术语确认", description: "确认同义词与标准名称" },
  { id: "format", title: "输出格式", description: "约束结构、证据与空值策略" },
  { id: "finalize", title: "最终修改", description: "补充额外说明并生成提示词" },
];

const WORKFLOW_DEFINITIONS = {
  field_template: {
    label: "字段模板生成",
    steps: FLOW_STEPS,
  },
  synonym_merge: {
    label: "仅同义词合并",
    steps: [
      { id: "target", title: "合并范围", description: "确认要合并的术语集合与应用场景" },
      { id: "synonym", title: "术语证据", description: "确认同义、别名、参见关系和不应合并项" },
      { id: "format", title: "合并规则", description: "约束证据、置信度、标准名和输出格式" },
      { id: "finalize", title: "最终修改", description: "补充边界条件并生成合并提示词" },
    ],
  },
  prompt_generation: {
    label: "完整提示词生成",
    steps: [
      { id: "role", title: "使用场景", description: "确定模型角色与 prompt 用途" },
      { id: "target", title: "任务目标", description: "确认待处理文档、任务边界和输入变量" },
      { id: "synonym", title: "术语确认", description: "确认同义词、相关项和禁止合并边界" },
      { id: "format", title: "输出约束", description: "确认输出结构、证据要求和失败策略" },
      { id: "finalize", title: "最终修改", description: "补充措辞偏好并生成提示词" },
    ],
  },
};

function getWorkflowDefinition(workflow) {
  return WORKFLOW_DEFINITIONS[workflow] || WORKFLOW_DEFINITIONS.field_template;
}

const GENERIC_LIBRARY = {
  steel: {
    label: "钢结构性能抽取",
    roles: ["通用数据工程师", "材料数据抽取员", "标准审核人员", "研究助理"],
    targets: ["性能词条", "构件类型", "连接方式", "病害与缺陷", "防护与加固措施"],
    candidateTerms: ["强度", "刚度", "稳定性", "延性", "韧性", "耐火性", "耐久性", "抗震性", "抗腐蚀性", "疲劳性能", "屈服性能", "承载能力"],
    constraints: ["保留原文证据句", "输出术语出现位置", "同义词合并去重", "给出字段置信度", "无法判断时输出 null", "保留中英文对照"],
    outputFormats: ["JSON 数组", "Markdown 表格", "CSV 字段", "三元组列表"],
  },
  corrosion: {
    label: "腐蚀信息抽取",
    roles: ["腐蚀数据工程师", "材料测试分析员", "标准审核人员", "研究助理"],
    targets: ["腐蚀类型", "腐蚀产物", "环境因素", "试验条件", "评价指标"],
    candidateTerms: ["点蚀", "缝隙腐蚀", "晶间腐蚀", "应力腐蚀", "腐蚀速率", "腐蚀电位", "失重", "温度", "氯离子浓度", "pH 值"],
    constraints: ["区分现象与机理", "保留单位", "保留试验环境", "标注句级证据", "同义表达归并"],
    outputFormats: ["JSON 对象", "Markdown 表格", "键值对清单", "知识图谱三元组"],
  },
  general: {
    label: "通用信息抽取",
    roles: ["通用数据工程师", "业务分析师", "内容审核人员", "研究助理"],
    targets: ["实体类型", "属性词条", "关系描述", "时间地点", "异常或结论"],
    candidateTerms: ["材料组成", "工艺参数", "性能指标", "测试方法", "实验条件", "应用场景", "风险点", "结论性描述"],
    constraints: ["保留原句", "区分事实与推测", "缺失项置空", "避免重复抽取", "保留章节标题"],
    outputFormats: ["JSON 数组", "Markdown 表格", "层级清单", "问答式摘要"],
  },
};

const SYNONYM_DICTIONARY = loadJsonConfig("synonym_examples.json", {});

const EVIDENCE_GRADE = {
  A: "A 级：证据强，可自动合并",
  B: "B 级：建议合并，需保留证据",
  C: "C 级：相关术语，不自动合并",
  D: "D 级：禁止合并",
};

const EVIDENCE_DECISION_MATRIX = {
  excel_includes_parameter: { grade: "A", action: "自动合并", relationType: "字段涵盖参数" },
  dictionary_alias: { grade: "A", action: "自动合并", relationType: "词典又称" },
  dictionary_see_also: { grade: "A", action: "自动合并", relationType: "词典见/参见" },
  exact_alias: { grade: "A", action: "自动合并", relationType: "精确别名" },
  standard_equivalent: { grade: "A", action: "自动合并", relationType: "标准等价术语" },
  bilingual_alias: { grade: "B", action: "建议合并", relationType: "中英文别名" },
  abbreviation: { grade: "B", action: "建议合并", relationType: "缩写/符号" },
  symbol_alias: { grade: "B", action: "建议合并", relationType: "符号别名" },
  llm_inferred: { grade: "B", action: "建议合并", relationType: "模型推断" },
  related_only: { grade: "C", action: "相关但不合并", relationType: "同类相关" },
  field_type_conflict: { grade: "D", action: "禁止合并", relationType: "字段类型冲突" },
  metric_type_conflict: { grade: "D", action: "禁止合并", relationType: "指标类型冲突" },
  semantic_boundary_conflict: { grade: "D", action: "禁止合并", relationType: "语义边界冲突" },
  category_type_conflict: { grade: "D", action: "禁止合并", relationType: "信息类别冲突" },
};

function getEvidenceDecision(evidenceType = "llm_inferred") {
  return EVIDENCE_DECISION_MATRIX[evidenceType] || EVIDENCE_DECISION_MATRIX.llm_inferred;
}

function makeSynonymValue(group) {
  return `${group.grade || "B"}|${group.canonical} => ${(group.aliases || []).join(" / ")}`;
}

function makeSynonymDescription(group) {
  const decision = getEvidenceDecision(group.evidenceType);
  return [
    EVIDENCE_GRADE[group.grade] || EVIDENCE_GRADE.B,
    group.evidenceType ? `证据类型：${group.evidenceType}` : "",
    decision.action ? `决策：${decision.action}` : "",
    group.relationType || decision.relationType ? `关系类型：${group.relationType || decision.relationType}` : "",
    group.evidenceText ? `证据：${group.evidenceText}` : "",
  ]
    .filter(Boolean)
    .join("；");
}

function classifyEvidence({ evidenceType = "llm_inferred", grade = "" } = {}) {
  if (grade) return grade;
  return getEvidenceDecision(evidenceType).grade;
}

function isLikelyAbbreviation(value) {
  const text = String(value || "").trim();
  return /^[A-Z]{2,8}$/.test(text) || /^[σγ][A-Za-z0-9_.′'’\-]{1,12}$/.test(text) || /^[A-Z][A-Za-z]?[0-9.]{1,8}$/.test(text);
}

function canonicalPriority(value, evidenceType = "") {
  const text = String(value || "").trim();
  if (!text) return -100;
  let score = Math.min(text.length, 36) * 0.05;
  if (/[\u4e00-\u9fff]/.test(text)) score += 3;
  if (/\bname\b$/i.test(text)) score += 2.5;
  if (/\b(value|unit|ratio|rate)\b$/i.test(text)) score += 1.2;
  if (/\s/.test(text)) score += 1;
  if (/^[A-Za-z][A-Za-z\s\-]+$/.test(text) && text.length > 8) score += 0.8;
  if (isLikelyAbbreviation(text)) score -= 4;
  if (evidenceType === "excel_includes_parameter") score += 1;
  return score;
}

function chooseCanonicalTerm(canonical, aliases, evidenceType = "") {
  const candidates = [canonical, ...(aliases || [])]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (!candidates.length) return { canonical: "", aliases: [] };

  const selected = candidates
    .map((term, index) => ({ term, index, score: canonicalPriority(term, evidenceType) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0].term;
  const selectedKey = selected.toLowerCase();
  return {
    canonical: selected,
    aliases: [...new Set(candidates.filter((item) => item.toLowerCase() !== selectedKey))],
  };
}

const FIELD_TYPE_SUFFIXES = ["name", "value", "unit", "ratio", "rate"];

function splitFieldTypedTerm(value) {
  const term = String(value || "").trim().replace(/\s+/g, " ");
  const lower = term.toLowerCase();
  for (const suffix of FIELD_TYPE_SUFFIXES) {
    if (!lower.endsWith(` ${suffix}`)) continue;
    const base = term.slice(0, -suffix.length).trim();
    if (!base) return null;
    return { term, base, suffix };
  }
  return null;
}

function getFieldConflictEvidence(leftSuffix, rightSuffix) {
  const labels = {
    name: "名称字段",
    value: "数值字段",
    unit: "单位字段",
    ratio: "比例指标",
    rate: "速率指标",
  };
  const metricSuffixes = new Set(["ratio", "rate"]);
  const evidenceType =
    metricSuffixes.has(leftSuffix) || metricSuffixes.has(rightSuffix)
      ? "metric_type_conflict"
      : "field_type_conflict";
  const evidenceText =
    evidenceType === "metric_type_conflict"
      ? `${labels[leftSuffix]}和${labels[rightSuffix]}属于不同指标或字段类型，不能直接合并。`
      : `${labels[leftSuffix]}和${labels[rightSuffix]}语义类型不同，不能合并。`;
  return { evidenceType, evidenceText };
}

function buildFieldConflictOptions(terms, normalizeAlias) {
  const parsedTerms = terms.map(splitFieldTypedTerm).filter(Boolean);
  const options = [];
  const seenPairs = new Set();

  for (let leftIndex = 0; leftIndex < parsedTerms.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < parsedTerms.length; rightIndex += 1) {
      const left = parsedTerms[leftIndex];
      const right = parsedTerms[rightIndex];
      if (left.suffix === right.suffix) continue;
      if (left.base.toLowerCase() !== right.base.toLowerCase()) continue;

      const pairKey = [normalizeAlias(left.term), normalizeAlias(right.term)].sort().join("|");
      if (!pairKey || seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const { evidenceType, evidenceText } = getFieldConflictEvidence(left.suffix, right.suffix);
      const group = {
        canonical: left.term,
        aliases: [right.term],
        evidenceType,
        grade: "D",
        evidenceText,
        disabled: true,
        autoSelect: false,
      };
      options.push({
        value: makeSynonymValue(group),
        label: `${left.term}: ${right.term}`,
        description: makeSynonymDescription(group),
        grade: group.grade,
        evidenceType: group.evidenceType,
        autoSelect: false,
        disabled: true,
      });
    }
  }

  return options;
}

const TERM_CONCEPT_PATTERNS = [
  {
    id: "material",
    label: "材料或材料类别",
    patterns: [
      /alloy|steel|glass|polymer|ceramic|composite|superalloy|foam glass|porous glass/i,
      /材料|合金|钢|玻璃|陶瓷|复合材料|高温合金|泡沫玻璃|多孔玻璃|塑料/,
    ],
  },
  {
    id: "performance",
    label: "性能指标",
    patterns: [
      /strength|hardness|ductility|toughness|elongation|fatigue|stiffness|performance|load-bearing/i,
      /性能|强度|屈服|抗拉|硬度|韧性|延性|伸长率|疲劳|刚度|承载/,
    ],
  },
  {
    id: "test_condition",
    label: "试验条件",
    patterns: [
      /test condition|temperature|duration|pressure|environment|pre-strain|strain rate|charging|hydrogen concentration/i,
      /试验条件|测试条件|温度|时间|压力|环境|预应变|应变速率|加载|充氢|氢浓度/,
    ],
  },
  {
    id: "measurement_result",
    label: "测量结果",
    patterns: [/value|ratio|rate|loss|result|percentage|iuts|potential/i, /数值|值|比例|速率|损失|结果|百分比|电位/],
  },
];

const TERM_FAMILY_PATTERNS = [
  { id: "strength", label: "强度类性能", patterns: [/strength/i, /强度|屈服|抗拉/] },
  { id: "corrosion", label: "腐蚀类指标", patterns: [/corrosion/i, /腐蚀|点蚀|缝隙腐蚀/] },
  { id: "hydrogen", label: "氢脆/充氢相关", patterns: [/hydrogen|embrittlement/i, /氢|氢脆|充氢/] },
  { id: "strain", label: "应变相关", patterns: [/strain/i, /应变/] },
  { id: "temperature", label: "温度相关", patterns: [/temperature/i, /温度/] },
];

function matchesAnyPattern(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function analyzeTerm(term) {
  const value = String(term || "").trim();
  const lower = value.toLowerCase();
  const fieldTyped = splitFieldTypedTerm(value);
  const concepts = new Set();
  const families = new Set();

  TERM_CONCEPT_PATTERNS.forEach((concept) => {
    if (matchesAnyPattern(value, concept.patterns)) concepts.add(concept.id);
  });
  TERM_FAMILY_PATTERNS.forEach((family) => {
    if (matchesAnyPattern(value, family.patterns)) families.add(family.id);
  });
  if (concepts.has("material") && concepts.has("test_condition") && !/test|condition|测试|试验|pre-strain|strain rate|charging|hydrogen concentration|预应变|应变速率|充氢|氢浓度/i.test(value)) {
    concepts.delete("test_condition");
  }

  let metricKind = "";
  if (/\bratio\b|percentage|iuts|损失率|比例|百分比/i.test(value)) metricKind = "ratio";
  else if (/\brate\b|速率/i.test(value)) metricKind = "rate";
  else if (/\bvalue\b|数值|值/i.test(value)) metricKind = "value";

  const isStrengthLoss = /strength loss|loss of strength|reduction in strength|percentage loss|iuts|强度损失/i.test(lower);
  const isStrengthMetric = /strength|强度|屈服|抗拉/i.test(value) && !isStrengthLoss;

  return {
    term: value,
    lower,
    fieldTyped,
    concepts,
    families,
    metricKind,
    isStrengthLoss,
    isStrengthMetric,
  };
}

function hasConcept(analysis, concept) {
  return analysis.concepts.has(concept);
}

function getSharedFamily(left, right) {
  for (const family of left.families) {
    if (right.families.has(family)) {
      return TERM_FAMILY_PATTERNS.find((item) => item.id === family)?.label || family;
    }
  }
  return "";
}

function getSemanticDecision(left, right) {
  if ((left.isStrengthLoss && right.isStrengthMetric) || (right.isStrengthLoss && left.isStrengthMetric)) {
    return {
      grade: "D",
      evidenceType: "semantic_boundary_conflict",
      evidenceText: "强度损失率描述强度下降比例或损失程度，强度值描述材料性能数值，二者不能合并。",
    };
  }

  if (
    left.metricKind &&
    right.metricKind &&
    left.metricKind !== right.metricKind &&
    ["ratio", "rate", "value"].includes(left.metricKind) &&
    ["ratio", "rate", "value"].includes(right.metricKind)
  ) {
    return {
      grade: "D",
      evidenceType: "metric_type_conflict",
      evidenceText: `${left.metricKind} 与 ${right.metricKind} 属于不同指标类型，不能直接合并。`,
    };
  }

  if (
    (hasConcept(left, "material") && (hasConcept(right, "performance") || hasConcept(right, "measurement_result") || hasConcept(right, "test_condition"))) ||
    (hasConcept(right, "material") && (hasConcept(left, "performance") || hasConcept(left, "measurement_result") || hasConcept(left, "test_condition")))
  ) {
    return {
      grade: "D",
      evidenceType: "category_type_conflict",
      evidenceText: "材料名或材料类别与性能指标、测量结果或试验条件属于不同信息类型，不能合并为同义词。",
    };
  }

  if (
    (hasConcept(left, "test_condition") && (hasConcept(right, "measurement_result") || hasConcept(right, "performance"))) ||
    (hasConcept(right, "test_condition") && (hasConcept(left, "measurement_result") || hasConcept(left, "performance")))
  ) {
    return {
      grade: "D",
      evidenceType: "category_type_conflict",
      evidenceText: "试验条件描述实验输入或环境，测量结果/性能指标描述输出结果，不能合并。",
    };
  }

  const sharedFamily = getSharedFamily(left, right);
  if (sharedFamily) {
    return {
      grade: "C",
      evidenceType: "related_only",
      evidenceText: `二者同属${sharedFamily}，但缺少同义、别名或符号等价证据，只能标记为相关术语。`,
    };
  }

  return null;
}

function getExistingPairKeys(options, normalizeAlias) {
  const keys = new Set();
  options.forEach((option) => {
    const [, relation = ""] = String(option.value || "").split("|");
    const [canonical, aliasesText = ""] = relation.split("=>").map((item) => item.trim());
    aliasesText
      .split(/\s*\/\s*/)
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((alias) => {
        const pairKey = [normalizeAlias(canonical), normalizeAlias(alias)].sort().join("|");
        if (pairKey) keys.add(pairKey);
      });
  });
  return keys;
}

function buildSemanticDecisionOptions(terms, normalizeAlias, existingOptions = []) {
  const cleanTerms = [...new Set(terms.map((item) => String(item || "").trim()).filter(Boolean))];
  const analyses = cleanTerms.map(analyzeTerm);
  const options = [];
  const seenPairs = getExistingPairKeys(existingOptions, normalizeAlias);

  for (let leftIndex = 0; leftIndex < analyses.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < analyses.length; rightIndex += 1) {
      const left = analyses[leftIndex];
      const right = analyses[rightIndex];
      const pairKey = [normalizeAlias(left.term), normalizeAlias(right.term)].sort().join("|");
      if (!pairKey || seenPairs.has(pairKey)) continue;

      const decision = getSemanticDecision(left, right);
      if (!decision) continue;
      seenPairs.add(pairKey);

      const group = {
        canonical: left.term,
        aliases: [right.term],
        evidenceType: decision.evidenceType,
        grade: decision.grade,
        evidenceText: decision.evidenceText,
        disabled: true,
        autoSelect: false,
      };
      options.push({
        value: makeSynonymValue(group),
        label: `${left.term}: ${right.term}`,
        description: makeSynonymDescription(group),
        grade: group.grade,
        evidenceType: group.evidenceType,
        autoSelect: false,
        disabled: true,
      });
    }
  }

  return options;
}

function inferScenario(promptText) {
  const normalized = String(promptText || "").trim().toLowerCase();
  if (normalized.includes("钢结构") || normalized.includes("steel")) {
    return { domainKey: "steel", intent: "information_extraction", label: "钢结构性能抽取" };
  }
  if (normalized.includes("腐蚀") || normalized.includes("corrosion")) {
    return { domainKey: "corrosion", intent: "information_extraction", label: "腐蚀信息抽取" };
  }
  return { domainKey: "general", intent: "information_extraction", label: "通用信息抽取" };
}

function extractExplicitTerms(text) {
  const value = String(text || "");
  const terms = new Set();
  const stopWords = new Set([
    "判断",
    "说明",
    "合并",
    "同义词",
    "同义词项",
    "概念",
    "边界",
    "证据",
    "词典",
    "是否",
    "可以",
    "作为",
    "之间",
    "哪些",
    "不能",
    "直接",
    "保留",
    "生成",
    "输出",
    "规则",
    "测试术语",
  ]);
  const asciiPattern = /[A-Za-zα-ωΑ-Ωσγ][A-Za-z0-9α-ωΑ-Ωσγσγ_.′'’\-]*(?:\s+[A-Za-zα-ωΑ-Ωσγ][A-Za-z0-9α-ωΑ-Ωσγ_.′'’\-]*){0,3}/g;
  let match = asciiPattern.exec(value);
  while (match) {
    const term = match[0].trim();
    if (term.length >= 2 && term.length <= 48 && !["and", "or", "the", "null", "JSON"].includes(term)) {
      terms.add(term);
    }
    match = asciiPattern.exec(value);
  }
  const symbolPattern = /[σγ][A-Za-z0-9_.′'’\-]{1,12}/g;
  match = symbolPattern.exec(value);
  while (match) {
    terms.add(match[0].trim());
    match = symbolPattern.exec(value);
  }
  value
    .split(/[\s,，、;；。.!?？：:()（）]+|和|与|及|以及|之间|是否|可以|作为|同义词项?|合并|判断|说明|保留|词典|证据|边界|哪些|相近|概念|不能|直接|的/g)
    .map((item) => item.trim())
    .filter((item) => /[\u4e00-\u9fff]/.test(item))
    .filter((item) => item.length >= 2 && item.length <= 16)
    .filter((item) => !stopWords.has(item))
    .forEach((item) => terms.add(item));
  return [...terms].slice(0, 16);
}

function withExplicitCandidateTerms(questions, prompt, knowledgeProfile) {
  const explicitTerms = [...new Set([...extractExplicitTerms(prompt), ...(knowledgeProfile?.candidateTerms || [])])].slice(0, 16);
  if (!explicitTerms.length) return questions;
  return questions.map((question) => {
    if (question.id !== "candidate_terms") return question;
    const existing = new Set((question.options || []).map((option) => option.value || option.label));
    const injected = explicitTerms
      .filter((term) => !existing.has(term))
      .map((term) => ({ value: term, label: term, description: "从原始需求或知识片段中识别出的显式术语。" }));
    return {
      ...question,
      options: [...injected, ...(question.options || [])].slice(0, 16),
    };
  });
}

function normalizeKnowledgeLine(line) {
  return String(line || "")
    .replace(/^[\s\-*+•·\d.、)）]+/, "")
    .replace(/^(?:内容|text)[：:]\s*/i, "")
    .trim();
}

function cleanBoundaryTerm(value) {
  return String(value || "")
    .replace(/^(?:定义|术语|字段)[：:]\s*/, "")
    .replace(/^(?:又称|见|参见)\s*/, "")
    .replace(/(?:直接|作为同义词|作为同义词项)?$/, "")
    .split(/[为是属于]/)[0]
    .trim()
    .replace(/[，,。；;：:]+$/, "")
    .trim();
}

function parseKnowledgeProfile(text, scenario) {
  const library = GENERIC_LIBRARY[scenario.domainKey];
  const synonyms = {};
  const terms = [];
  const synonymGroups = [];
  let currentFieldName = "";

  function splitAliasText(value) {
    return String(value || "")
      .split(/\s*(?:[;；|、,，/]|\b和\b|\band\b)\s*/i)
      .map(cleanBoundaryTerm)
      .filter((item) => item && item.length <= 60);
  }

  function addSynonymGroup(canonical, aliases, evidence = {}) {
    const evidenceType = evidence.evidenceType || "llm_inferred";
    const selectedTerms = chooseCanonicalTerm(canonical, aliases, evidenceType);
    const cleanCanonical = selectedTerms.canonical;
    const cleanAliases = selectedTerms.aliases;
    if (!cleanCanonical || !cleanAliases.length) return;
    const grade = classifyEvidence({ evidenceType, grade: evidence.grade });
    const decision = getEvidenceDecision(evidenceType);
    synonymGroups.push({
      canonical: cleanCanonical,
      aliases: cleanAliases,
      evidenceType,
      grade,
      relationType: evidence.relationType || decision.relationType,
      evidenceText: evidence.evidenceText || "",
      autoSelect: grade === "A",
      disabled: grade === "C" || grade === "D",
    });
    terms.push(cleanCanonical);
    synonyms[cleanCanonical] = [...new Set([...(synonyms[cleanCanonical] || []), ...cleanAliases])];
    cleanAliases.forEach((alias) => {
      terms.push(alias);
      synonyms[alias] = [...new Set([cleanCanonical, ...(synonyms[alias] || []), ...cleanAliases.filter((item) => item !== alias)])];
    });
  }

  function addForbiddenBoundaryGroups(item) {
    const boundaryMatch = String(item || "").match(/([^。；;，,]{2,60}?)(?:为[^，。；;]*)?[，,]?\s*不能与\s*([^。；;，,]{2,60}?)(?:直接)?合并/);
    if (!boundaryMatch) return;
    const left = cleanBoundaryTerm(boundaryMatch[1]);
    const right = cleanBoundaryTerm(boundaryMatch[2]);
    if (!left || !right || left === right) return;
    addSynonymGroup(right, [left], {
      evidenceType: "category_type_conflict",
      grade: "D",
      evidenceText: item,
      relationType: "知识片段禁止合并",
    });
  }

  function addFreeTextEvidenceGroups(item) {
    const text = String(item || "").trim();
    const explicitTargetMatch = text.match(
      /^(.{2,160}?)(?:表示|均为|同为|都是|属于)(.{0,40}?)(?:字段|术语|表达|参数|指标)[^。；;]*?(?:可|可以|应|应该|视为|作为|按)[^。；;]*?(?:同义|别名|等价|合并|归并)[^。；;]*?(?:到|为|至)\s*([^。；;，,]{2,80})/
    );
    if (explicitTargetMatch) {
      const aliases = splitAliasText(explicitTargetMatch[1]);
      addSynonymGroup(cleanBoundaryTerm(explicitTargetMatch[3]), aliases, {
        evidenceType: "exact_alias",
        grade: "A",
        relationType: "自由文本同义证据",
        evidenceText: item,
      });
      return true;
    }

    const sameFieldMatch = text.match(
      /^(.{2,180}?)(?:表示|均为|同为|都是|属于)(.{0,60}?)(?:字段|术语|表达|参数|指标)[^。；;]*?(?:同义|别名|等价|合并|归并)/
    );
    if (sameFieldMatch) {
      const aliases = splitAliasText(sameFieldMatch[1]);
      if (aliases.length >= 2) {
        addSynonymGroup(aliases[0], aliases.slice(1), {
          evidenceType: "exact_alias",
          grade: "A",
          relationType: "自由文本同义证据",
          evidenceText: item,
        });
        return true;
      }
    }

    const aliasMatch = text.match(/^([^。；;，,]{2,80}?)(?:又称|也称|亦称|别称|等价于|等同于|即)\s*([^。；;]{2,140})/);
    if (aliasMatch) {
      addSynonymGroup(cleanBoundaryTerm(aliasMatch[1]), splitAliasText(aliasMatch[2]), {
        evidenceType: "dictionary_alias",
        grade: "A",
        relationType: "自由文本又称/等价",
        evidenceText: item,
      });
      return true;
    }

    const abbreviationMatch = text.match(/^([^。；;，,]{2,80}?)(?:缩写为|简称|符号为|记作)\s*([^。；;，,]{2,80})/);
    if (abbreviationMatch) {
      addSynonymGroup(cleanBoundaryTerm(abbreviationMatch[1]), splitAliasText(abbreviationMatch[2]), {
        evidenceType: "abbreviation",
        grade: "B",
        relationType: "自由文本缩写/符号",
        evidenceText: item,
      });
      return true;
    }

    return false;
  }

  String(text || "")
    .split(/\n/)
    .map(normalizeKnowledgeLine)
    .filter(Boolean)
    .forEach((item) => {
      const synonymMatch = item.match(/^同义词组[：:]\s*(.+?)\s*=>\s*(.+?)(?:\s*（证据类型：(.+?)；证据等级：(.+?)；证据文本：(.+?)）)?$/);
      if (synonymMatch) {
        addSynonymGroup(synonymMatch[1], synonymMatch[2].split(/[;；|]/), {
          evidenceType: synonymMatch[3] || "excel_includes_parameter",
          grade: synonymMatch[4] || "",
          evidenceText: synonymMatch[5] || item,
        });
        return;
      }

      const fieldMatch = item.match(/^(?:字段|列名)[：:]\s*(.+)$/);
      if (fieldMatch) {
        currentFieldName = fieldMatch[1].trim();
        terms.push(currentFieldName);
        return;
      }

      const includesMatch = item.match(/^涵盖参数[：:]\s*(.+)$/);
      if (includesMatch && currentFieldName) {
        addSynonymGroup(currentFieldName, includesMatch[1].split(/[;；|/]/), {
          evidenceType: "excel_includes_parameter",
          evidenceText: item,
        });
        return;
      }

      const aliasMatch = item.match(/^术语[：:]\s*(.+)$/);
      if (aliasMatch) {
        terms.push(aliasMatch[1].trim());
        return;
      }

      const definitionAliasMatch = item.match(/^定义[：:]\s*又称(.+?)[。；;，,]/);
      if (definitionAliasMatch && terms.length) {
        addSynonymGroup(terms[terms.length - 1], definitionAliasMatch[1].split(/[、,，;；/]/), {
          evidenceType: "dictionary_alias",
          evidenceText: item,
        });
        addForbiddenBoundaryGroups(item);
        return;
      }

      const seeAlsoMatch = item.match(/^定义[：:]\s*(?:见|参见)(.+?)(?:[（(]|[。；;，,]|$)/);
      if (seeAlsoMatch && terms.length) {
        addSynonymGroup(seeAlsoMatch[1].trim(), [terms[terms.length - 1]], {
          evidenceType: "dictionary_see_also",
          evidenceText: item,
        });
        addForbiddenBoundaryGroups(item);
        return;
      }

      if (addFreeTextEvidenceGroups(item)) {
        addForbiddenBoundaryGroups(item);
        return;
      }

      addForbiddenBoundaryGroups(item);

      if (item.includes("：") || item.includes(":")) return;

      const fragments = item.split(/[,，;；、|]/).map(normalizeKnowledgeLine).filter(Boolean);
      if (fragments.length > 1) {
        fragments.forEach((fragment) => {
          if (fragment.includes("：") || fragment.includes(":")) return;
          const bilingualMatch = fragment.match(/^([A-Za-z][A-Za-z\s\-_/]+)[（(]([^）)]+)[）)]$/);
          const reverseBilingualMatch = fragment.match(/^([^（()]+)[（(]([A-Za-z][A-Za-z\s\-_/]+)[）)]$/);
          const term = bilingualMatch ? bilingualMatch[2].trim() : reverseBilingualMatch ? reverseBilingualMatch[1].trim() : fragment.trim();
          const alias = bilingualMatch
            ? `${bilingualMatch[1].trim()}（${term}）`
            : reverseBilingualMatch
              ? `${reverseBilingualMatch[2].trim()}（${term}）`
              : "";
          if (term.length < 2 || term.length > 28) return;
          terms.push(term);
          if (alias) synonyms[term] = [...(synonyms[term] || []), alias];
        });
        return;
      }

      const bilingualMatch = item.match(/^([A-Za-z][A-Za-z\s\-_/]+)[（(]([^）)]+)[）)]$/);
      const reverseBilingualMatch = item.match(/^([^（()]+)[（(]([A-Za-z][A-Za-z\s\-_/]+)[）)]$/);
      const term = bilingualMatch ? bilingualMatch[2].trim() : reverseBilingualMatch ? reverseBilingualMatch[1].trim() : item.trim();
      const alias = bilingualMatch
        ? `${bilingualMatch[1].trim()}（${term}）`
        : reverseBilingualMatch
          ? `${reverseBilingualMatch[2].trim()}（${term}）`
          : "";

      if (term.length < 2 || term.length > 28) return;
      terms.push(term);
      if (alias) synonyms[term] = [...(synonyms[term] || []), alias];
    });

  const uniqueTerms = [...new Set(terms)];
  return {
    candidateTerms: uniqueTerms.length >= 4 ? uniqueTerms.slice(0, 16) : library.candidateTerms,
    synonyms,
    synonymGroups,
    sourceLabel: uniqueTerms.length >= 4 ? "RAG 术语片段" : "RAG 片段不足，回退通用模板",
  };
}

function getSynonymOptions(terms, knowledgeProfile) {
  const normalizeAlias = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[：:'"“”‘’（）()[\]\s_\-]+/g, "")
      .trim();

  const selectedKeys = new Set(terms.map(normalizeAlias).filter(Boolean));
  const usedKeys = new Set();
  const options = [];

  (knowledgeProfile?.synonymGroups || []).forEach((group) => {
    const canonical = group.canonical;
    const aliases = Array.isArray(group.aliases) ? group.aliases : [];
    const members = [canonical, ...aliases];
    const memberKeys = members.map(normalizeAlias).filter(Boolean);
    if (!memberKeys.some((key) => selectedKeys.has(key))) return;
    if (!["C", "D"].includes(group.grade) && memberKeys.some((key) => usedKeys.has(key))) return;

    const canonicalKey = normalizeAlias(canonical);
    const related = [...new Set(aliases)].filter((item) => normalizeAlias(item) && normalizeAlias(item) !== canonicalKey);
    if (!canonicalKey || !related.length) return;

    if (!["C", "D"].includes(group.grade)) {
      memberKeys.forEach((key) => usedKeys.add(key));
    }
    options.push({
      value: makeSynonymValue(group),
      label: `${canonical}: ${related.join(" / ")}`,
      description: makeSynonymDescription(group),
      grade: group.grade,
      evidenceType: group.evidenceType,
      autoSelect: group.autoSelect,
      disabled: group.disabled,
    });
  });

  terms.forEach((term) => {
    const termKey = normalizeAlias(term);
    if (!termKey || usedKeys.has(termKey)) return;
    const ragRelated = knowledgeProfile?.synonyms?.[term] || [];
    const related = [...new Set([...ragRelated, ...(SYNONYM_DICTIONARY[term] || [])])].filter(
      (item) => normalizeAlias(item) && normalizeAlias(item) !== termKey && !usedKeys.has(normalizeAlias(item))
    );
    if (!related.length) return;
    [term, ...related].map(normalizeAlias).filter(Boolean).forEach((key) => usedKeys.add(key));
    const selectedTerms = chooseCanonicalTerm(term, related, "bilingual_alias");
    const group = {
      canonical: selectedTerms.canonical,
      aliases: selectedTerms.aliases,
      evidenceType: "bilingual_alias",
      grade: "B",
      relationType: getEvidenceDecision("bilingual_alias").relationType,
      evidenceText: "内置通用术语词典",
    };
    options.push({
      value: makeSynonymValue(group),
      label: `${term}: ${related.join(" / ")}`,
      description: makeSynonymDescription(group),
      grade: group.grade,
      evidenceType: group.evidenceType,
      autoSelect: false,
      disabled: false,
    });
  });

  options.push(...buildFieldConflictOptions(terms, normalizeAlias));
  options.push(...buildSemanticDecisionOptions(terms, normalizeAlias, options));

  return options;
}

function buildQuestions({ sourceMode, scenario, knowledgeProfile, workflow = "field_template" }) {
  const library = GENERIC_LIBRARY[scenario.domainKey];
  const candidateTerms = sourceMode === "rag" && knowledgeProfile ? knowledgeProfile.candidateTerms : library.candidateTerms;

  if (workflow === "synonym_merge") {
    return [
      {
        id: "target_type",
        stepId: "target",
        type: "single",
        category: "合并范围",
        title: "这次同义词合并主要服务于哪类结果？",
        description: "不同用途会影响标准名选择、合并边界和证据要求。",
        options: ["抽取字段标准化", "材料术语归一", "中英文别名合并", "标准/规范术语对齐"].map((item) => ({
          value: item,
          label: item,
          description: `以${item}为主要合并目标。`,
        })),
        required: true,
      },
      {
        id: "candidate_terms",
        stepId: "target",
        type: "multi",
        category: "合并范围",
        title: "请选择需要进入合并判断的术语",
        description: sourceMode === "rag" ? "候选项优先来自当前知识库召回；可以手动补充遗漏术语。" : "当前使用通用候选项；可以手动补充真实术语。",
        options: candidateTerms.map((item) => ({ value: item, label: item, description: "纳入本轮同义词/别名合并判断。" })),
        required: true,
      },
      {
        id: "bilingual_synonym",
        stepId: "synonym",
        type: "boolean",
        category: "术语证据",
        title: "是否把中英文、缩写和符号视为可合并候选？",
        description: "例如 yield strength、YS、σ0.2、Rp0.2 这类表达。",
        options: [
          { value: "yes", label: "是", description: "纳入中英文、缩写和符号别名。" },
          { value: "no", label: "否", description: "只处理同语言内的近义或别名。" },
        ],
        required: true,
      },
      {
        id: "synonym_groups",
        stepId: "synonym",
        type: "multi",
        category: "术语证据",
        title: "请确认可合并的同义词组",
        description: "系统会优先展示 Excel 涵盖参数、词典又称/见/参见等证据形成的候选组。",
        options: [],
        required: false,
      },
      {
        id: "merge_policy",
        stepId: "format",
        type: "single",
        category: "合并规则",
        title: "遇到相近但不完全等价的概念时怎么处理？",
        description: "这一步决定是否保守合并。",
        options: [
          { value: "严格合并", label: "严格合并", description: "只有明确同义、别名、缩写、又称、见/参见才合并。" },
          { value: "宽松聚类", label: "宽松聚类", description: "允许近义词或同类术语进入同一候选簇，但标注关系类型。" },
          { value: "人工复核优先", label: "人工复核优先", description: "低证据项进入待确认列表，不自动合并。" },
        ],
        required: true,
      },
      {
        id: "output_format",
        stepId: "format",
        type: "single",
        category: "合并规则",
        title: "同义词合并结果用什么格式输出？",
        description: "建议输出可审计的标准名、别名、证据和置信度。",
        options: ["JSON 数组", "Markdown 表格", "标准名-别名映射表", "待复核清单"].map((item) => ({
          value: item,
          label: item,
          description: `按照${item}输出合并结果。`,
        })),
        required: true,
      },
      {
        id: "constraints",
        stepId: "format",
        type: "multi",
        category: "合并规则",
        title: "合并时必须保留哪些审计信息？",
        description: "这些信息会帮助用户判断候选组是否可信。",
        options: ["知识来源", "证据原文", "关系类型", "置信度", "不合并原因", "人工复核标记"].map((item) => ({
          value: item,
          label: item,
          description: "作为同义词合并质量约束加入提示词。",
        })),
        required: false,
      },
      {
        id: "extra_instructions",
        stepId: "finalize",
        type: "text",
        category: "最终修改",
        title: "还有哪些合并边界需要说明？",
        description: "例如哪些术语不能合并、标准名优先级、单位差异处理方式。",
        placeholder: "例如：强度值和强度损失率不能合并。",
        required: false,
      },
    ];
  }

  if (workflow === "prompt_generation") {
    return [
      {
        id: "business_role",
        stepId: "role",
        type: "single",
        category: "使用场景",
        title: "这个提示词最终要让模型扮演什么角色？",
        description: "角色会影响最终 prompt 的语气、检查规则和专业边界。",
        options: library.roles.map((item) => ({ value: item, label: item, description: `最终提示词会以${item}作为模型角色。` })),
        required: true,
      },
      {
        id: "target_type",
        stepId: "target",
        type: "single",
        category: "任务目标",
        title: "最终提示词主要解决哪类任务？",
        description: "这一步决定 prompt 主体结构。",
        options: ["信息抽取", "同义词合并", "术语标准化", "质量审核", "结构化总结"].map((item) => ({
          value: item,
          label: item,
          description: `围绕${item}生成可执行提示词。`,
        })),
        required: true,
      },
      {
        id: "candidate_terms",
        stepId: "target",
        type: "multi",
        category: "任务目标",
        title: "提示词中需要重点覆盖哪些对象或字段？",
        description: "可选择知识库召回候选项，也可以手动补充。",
        options: candidateTerms.map((item) => ({ value: item, label: item, description: "写入提示词的重点对象或字段范围。" })),
        required: false,
      },
      {
        id: "bilingual_synonym",
        stepId: "synonym",
        type: "boolean",
        category: "术语确认",
        title: "最终提示词是否需要包含同义词归并与术语边界？",
        description: "同义词合并是提示词生成的重要组成部分；建议保留这一步。",
        options: [
          { value: "yes", label: "是", description: "把同义词、近义相关项和禁止合并边界写入最终提示词。" },
          { value: "no", label: "否", description: "仅生成普通任务提示词，不强制术语归并。" },
        ],
        required: true,
      },
      {
        id: "synonym_groups",
        stepId: "synonym",
        type: "multi",
        category: "术语确认",
        title: "请确认最终提示词需要采用的同义词与边界证据",
        description: "A/B 项会作为可合并关系进入提示词；C/D 项会作为相关但不合并或禁止合并边界保留。",
        options: [],
        required: false,
      },
      {
        id: "merge_policy",
        stepId: "synonym",
        type: "single",
        category: "术语确认",
        title: "最终提示词应采用哪种术语合并策略？",
        description: "这会控制模型在执行抽取或总结时如何处理相近术语。",
        options: [
          { value: "严格合并", label: "严格合并", description: "只有明确同义、别名、缩写、又称、见/参见才合并。" },
          { value: "宽松聚类", label: "宽松聚类", description: "允许近义词或同类术语进入同一候选簇，但标注关系类型。" },
          { value: "人工复核优先", label: "人工复核优先", description: "低证据项进入待确认列表，不自动合并。" },
        ],
        required: true,
      },
      {
        id: "output_format",
        stepId: "format",
        type: "single",
        category: "输出约束",
        title: "希望最终任务输出是什么结构？",
        description: "最终 prompt 会明确要求模型按这个结构回答。",
        options: library.outputFormats.map((item) => ({ value: item, label: item, description: `要求被调用模型按照${item}输出。` })),
        required: true,
      },
      {
        id: "constraints",
        stepId: "format",
        type: "multi",
        category: "输出约束",
        title: "提示词中必须加入哪些执行约束？",
        description: "这些约束用于减少幻觉、格式错误和边界漂移。",
        options: [...new Set([...library.constraints, "只基于原文", "先列证据再输出", "输出前自检", "不确定时标记待确认"])].map((item) => ({
          value: item,
          label: item,
          description: "作为最终 prompt 的执行规则。",
        })),
        required: false,
      },
      {
        id: "extra_instructions",
        stepId: "finalize",
        type: "text",
        category: "最终修改",
        title: "还有哪些措辞或业务偏好？",
        description: "例如输出语言、字段命名、失败策略、是否允许解释过程。",
        placeholder: "例如：不要输出推理过程；字段名使用中文；没有证据时输出 null。",
        required: false,
      },
    ];
  }

  return [
    {
      id: "business_role",
      stepId: "role",
      type: "single",
      category: "角色与背景",
      title: "当前业务角色更接近哪一种？",
      description: "这一步用于确定提示词的专业语气与任务上下文。",
      options: library.roles.map((item) => ({ value: item, label: item, description: `后续问题会按 ${item} 的工作方式组织。` })),
      required: true,
    },
    {
      id: "target_type",
      stepId: "target",
      type: "single",
      category: "抽取目标",
      title: "你希望系统聚焦抽取哪一类内容？",
      description: "这一步决定后续候选项与最终提示词的任务边界。",
      options: library.targets.map((item) => ({ value: item, label: item, description: `将 ${item} 作为本次抽取的主目标。` })),
      required: true,
    },
    {
      id: "candidate_terms",
      stepId: "target",
      type: "multi",
      category: "抽取目标",
      title: "请选择你希望纳入的候选词条",
      description: sourceMode === "rag" ? "当前优先从附带术语片段中提取候选项，你可以多选确认。" : "当前基于通用模板组织候选项，你可以多选确认。",
      options: candidateTerms.map((item) => ({ value: item, label: item, description: "选中后会写入提示词中的候选术语集合。" })),
      required: true,
    },
    {
      id: "bilingual_synonym",
      stepId: "synonym",
      type: "boolean",
      category: "术语确认",
      title: "是否要求英文术语附带中文翻译，并进行同义词归并？",
      description: "适用于术语标准化、别名合并与中英文结果对齐。",
      options: [
        { value: "yes", label: "是", description: "强制英文附中文翻译，并进行同义词归并。" },
        { value: "no", label: "否", description: "保留原术语，不强制做中英文归并。" },
      ],
      required: true,
    },
    {
      id: "synonym_groups",
      stepId: "synonym",
      type: "multi",
      category: "术语确认",
      title: "请确认以下属性的同义词或同类表达",
      description: "系统会根据你前面选择的词条生成待确认的同义词组。",
      options: [],
      required: false,
    },
    {
      id: "output_format",
      stepId: "format",
      type: "single",
      category: "输出格式",
      title: "你希望输出格式是什么？",
      description: "最终提示词会明确指定模型输出的结构。",
      options: library.outputFormats.map((item) => ({ value: item, label: item, description: `要求模型按照 ${item} 输出。` })),
      required: true,
    },
    {
      id: "constraints",
      stepId: "format",
      type: "multi",
      category: "输出格式",
      title: "你还希望加入哪些约束？",
      description: "这些约束会体现在最终提示词的执行细节里。",
      options: library.constraints.map((item) => ({ value: item, label: item, description: "作为抽取质量约束加入提示词。" })),
      required: false,
    },
    {
      id: "extra_instructions",
      stepId: "finalize",
      type: "text",
      category: "最终修改",
      title: "还有没有额外说明？",
      description: "例如字段命名规则、输出语言、是否允许空值等。",
      placeholder: "例如：字段名统一用中文；若没有证据句则不要臆造。",
      required: false,
    },
  ];
}

function parseCustomItems(value) {
  return String(value || "")
    .split(/[\n,，;；、|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getDefaultAnswers(questions) {
  const answers = {};
  questions.forEach((question) => {
    if (question.type === "multi") answers[question.id] = [];
    else if (question.type === "boolean") answers[question.id] = "yes";
    else answers[question.id] = "";
  });
  return answers;
}

function getDefaultCustomAnswers(questions) {
  const customAnswers = {};
  questions.forEach((question) => {
    if (question.type !== "text") customAnswers[question.id] = "";
  });
  return customAnswers;
}

function normalizeForInference(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ");
}

function optionValue(question, label) {
  return (question?.options || []).find((option) => option.value === label || option.label === label)?.value || "";
}

function inferAutoAnswers({ prompt, workflow, questions }) {
  const text = normalizeForInference(prompt);
  const byId = new Map(questions.map((question) => [question.id, question]));
  const autoAnswers = {};

  function setAnswer(questionId, answer, reason) {
    if (answer === "" || answer == null || (Array.isArray(answer) && !answer.length)) return;
    autoAnswers[questionId] = { answer, reason };
  }

  const targetQuestion = byId.get("target_type");
  if (targetQuestion) {
    if (workflow === "synonym_merge") {
      if (/材料|material|alloy|glass|foam glass|porous glass|术语归一/.test(text)) {
        setAnswer("target_type", optionValue(targetQuestion, "材料术语归一"), "原始需求已指向材料术语归一。");
      } else if (/字段|field|column|抽取字段/.test(text)) {
        setAnswer("target_type", optionValue(targetQuestion, "抽取字段标准化"), "原始需求已指向字段标准化。");
      } else if (/标准|规范|standard/.test(text)) {
        setAnswer("target_type", optionValue(targetQuestion, "标准/规范术语对齐"), "原始需求已指向标准术语对齐。");
      } else if (/中英文|英文|缩写|符号|alias|abbreviation/.test(text)) {
        setAnswer("target_type", optionValue(targetQuestion, "中英文别名合并"), "原始需求已指向中英文别名合并。");
      }
    } else if (/抽取|extract|提取|信息抽取/.test(text)) {
      setAnswer("target_type", optionValue(targetQuestion, "信息抽取") || optionValue(targetQuestion, "性能词条"), "原始需求已明确是抽取任务。");
    } else if (/同义词|合并|归一|标准化/.test(text)) {
      setAnswer("target_type", optionValue(targetQuestion, "同义词合并") || optionValue(targetQuestion, "术语标准化"), "原始需求已明确是术语合并/标准化任务。");
    }
  }

  const outputQuestion = byId.get("output_format");
  if (outputQuestion) {
    if (/json\s*数组|json array/.test(text)) setAnswer("output_format", optionValue(outputQuestion, "JSON 数组"), "原始需求已指定 JSON 数组。");
    else if (/json\s*对象|json object/.test(text)) setAnswer("output_format", optionValue(outputQuestion, "JSON 对象"), "原始需求已指定 JSON 对象。");
    else if (/markdown\s*表格|markdown table/.test(text)) setAnswer("output_format", optionValue(outputQuestion, "Markdown 表格"), "原始需求已指定 Markdown 表格。");
    else if (/\bcsv\b/.test(text)) setAnswer("output_format", optionValue(outputQuestion, "CSV 字段"), "原始需求已指定 CSV。");
  }

  const bilingualQuestion = byId.get("bilingual_synonym");
  if (bilingualQuestion) {
    if (/不需要.*(同义|归并|合并)|无需.*(同义|归并|合并)|不强制.*(同义|归并|合并)/.test(text)) {
      setAnswer("bilingual_synonym", "no", "原始需求明确不需要同义词归并。");
    } else if (/同义词|别名|中英文|英文|缩写|符号|归并|合并|alias|abbreviation/.test(text)) {
      setAnswer("bilingual_synonym", "yes", "原始需求已要求同义词/别名处理。");
    }
  }

  const mergePolicyQuestion = byId.get("merge_policy");
  if (mergePolicyQuestion) {
    if (/严格|只有明确|不得.*推断|不能.*推断/.test(text)) {
      setAnswer("merge_policy", optionValue(mergePolicyQuestion, "严格合并"), "原始需求已要求严格合并。");
    } else if (/人工复核|待确认|复核/.test(text)) {
      setAnswer("merge_policy", optionValue(mergePolicyQuestion, "人工复核优先"), "原始需求已要求人工复核。");
    } else if (/宽松|聚类|近义/.test(text)) {
      setAnswer("merge_policy", optionValue(mergePolicyQuestion, "宽松聚类"), "原始需求已允许宽松聚类。");
    }
  }

  const constraintsQuestion = byId.get("constraints");
  if (constraintsQuestion) {
    const requested = (constraintsQuestion.options || [])
      .filter((option) => {
        const value = String(option.value || option.label || "");
        if (text.includes(value.toLowerCase())) return true;
        if (value === "保留原文证据句" && /证据句|原文证据|证据原文/.test(text)) return true;
        if (value === "证据原文" && /证据句|原文证据|证据原文/.test(text)) return true;
        if (value === "输出前自检" && /自检|检查/.test(text)) return true;
        if (value === "不确定时标记待确认" && /不确定|待确认/.test(text)) return true;
        if (value === "不合并原因" && /不合并原因|不能合并|禁止合并/.test(text)) return true;
        return false;
      })
      .map((option) => option.value);
    if (requested.length >= 2) setAnswer("constraints", [...new Set(requested)], "原始需求已明确多个执行约束。");
  }

  return autoAnswers;
}

function getAnswerWithCustom(session, questionId, type) {
  const answer = session.answers[questionId];
  const customItems = parseCustomItems(session.customAnswers[questionId]);
  if (type === "multi") return [...new Set([...(Array.isArray(answer) ? answer : []), ...customItems])];
  if (type === "text") return answer || "";
  return answer === "__custom__" ? customItems.join("；") : answer || customItems.join("；");
}

function formatSynonymEvidenceItem(item) {
  const value = typeof item === "string" ? item : item.value || item.label || "";
  const [gradePart, ...relationParts] = String(value).split("|");
  if (!relationParts.length) return `- ${String(value)}`;
  const relation = relationParts.join("|") || item.label || String(value);
  const detail = typeof item === "string" ? "" : item.description || "";
  return `- ${gradePart || "B"} 级：${relation}${detail ? `；${detail}` : ""}`;
}

function formatSynonymEvidenceSection(title, items) {
  const lines = items.length ? items.map(formatSynonymEvidenceItem) : ["- 无"];
  return [title, ...lines].join("\n");
}

function getSynonymEvidenceSummary(session) {
  const selected = getAnswerWithCustom(session, "synonym_groups", "multi");
  const question = session.questions.find((item) => item.id === "synonym_groups");
  const options = question?.options || [];
  if (!selected.length && !options.length) return "按已选术语自动归并";

  const optionByValue = new Map(options.map((option) => [String(option.value), option]));
  const selectedItems = selected.map((value) => {
    const text = String(value);
    return (
      optionByValue.get(text) ||
      options.find((option) => !option.disabled && (String(option.value).includes(`${text} =>`) || String(option.label).startsWith(`${text}:`))) ||
      options.find((option) => String(option.value).includes(`${text} =>`) || String(option.label).startsWith(`${text}:`)) ||
      text
    );
  });
  const relatedOnlyItems = options.filter((option) => option.grade === "C" || option.evidenceType === "related_only");
  const forbiddenItems = options.filter((option) => option.grade === "D");

  return [
    formatSynonymEvidenceSection("自动/确认合并项：", selectedItems),
    formatSynonymEvidenceSection("相关但不合并项：", relatedOnlyItems),
    formatSynonymEvidenceSection("禁止合并项：", forbiddenItems),
  ].join("\n");
}

function refreshSynonymQuestion(session) {
  const question = session.questions.find((item) => item.id === "synonym_groups");
  if (!question) return;
  const selectedTerms = getAnswerWithCustom(session, "candidate_terms", "multi");
  const fallbackTerms = GENERIC_LIBRARY[session.scenario.domainKey].candidateTerms.slice(0, 3);
  question.options = getSynonymOptions(selectedTerms.length ? selectedTerms : fallbackTerms, session.knowledgeProfile);
  const current = Array.isArray(session.answers.synonym_groups) ? session.answers.synonym_groups : [];
  if (!current.length) {
    session.answers.synonym_groups = question.options.filter((option) => option.autoSelect && !option.disabled).map((option) => option.value);
  }
}

function shouldSkipQuestion(session, question) {
  if (!question) return false;
  if (session.autoAnswers?.[question.id]) return true;
  if (question.id !== "synonym_groups") return false;
  refreshSynonymQuestion(session);
  return getAnswerWithCustom(session, "bilingual_synonym", "boolean") === "no" || !question.options.length;
}

function clearSkippedQuestionAnswer(session, question) {
  if (!question || session.autoAnswers?.[question.id]) return;
  session.answers[question.id] = question.type === "multi" ? [] : "";
}

function moveToFirstUnskippedQuestion(session) {
  session.currentIndex = 0;
  while (session.currentIndex < session.questions.length - 1 && shouldSkipQuestion(session, session.questions[session.currentIndex])) {
    session.currentIndex += 1;
  }
}

function getCurrentQuestion(session) {
  refreshSynonymQuestion(session);
  return session.questions[session.currentIndex] || null;
}

function advanceToNextQuestion(session) {
  while (session.currentIndex < session.questions.length - 1) {
    session.currentIndex += 1;
    if (!shouldSkipQuestion(session, session.questions[session.currentIndex])) return;
    clearSkippedQuestionAnswer(session, session.questions[session.currentIndex]);
  }
}

function moveToPreviousQuestion(session) {
  while (session.currentIndex > 0) {
    session.currentIndex -= 1;
    if (!shouldSkipQuestion(session, session.questions[session.currentIndex])) return;
  }
}

function normalizeLLMQuestions(baseQuestions, llmQuestions) {
  const llmMap = new Map((Array.isArray(llmQuestions) ? llmQuestions : []).filter((question) => question?.id).map((question) => [question.id, question]));

  return baseQuestions.map((baseQuestion) => {
    const llmQuestion = llmMap.get(baseQuestion.id);
    if (!llmQuestion) return baseQuestion;

    const merged = {
      ...baseQuestion,
      title: typeof llmQuestion.title === "string" ? llmQuestion.title : baseQuestion.title,
      description: typeof llmQuestion.description === "string" ? llmQuestion.description : baseQuestion.description,
      category: typeof llmQuestion.category === "string" ? llmQuestion.category : baseQuestion.category,
      placeholder: typeof llmQuestion.placeholder === "string" ? llmQuestion.placeholder : baseQuestion.placeholder,
    };

    if (Array.isArray(llmQuestion.options) && llmQuestion.options.length && !["text", "boolean"].includes(baseQuestion.type)) {
      merged.options = llmQuestion.options
        .map((option) => {
          if (typeof option === "string") return { value: option, label: option, description: "由 LLM 根据当前任务生成。" };
          const value = String(option.value || option.label || "").trim();
          if (!value) return null;
          return {
            value,
            label: String(option.label || value),
            description: String(option.description || "由 LLM 根据当前任务生成。"),
          };
        })
        .filter(Boolean)
        .slice(0, 16);
    }

    return merged;
  });
}

function extractJsonObject(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("LLM 未返回可解析的 JSON。");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizeLLMContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => normalizeLLMContent(item))
      .filter(Boolean)
      .join("\n");
  }

  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    if (typeof content.value === "string") return content.value;
    if (Array.isArray(content.content)) return normalizeLLMContent(content.content);
    return JSON.stringify(content);
  }

  return content == null ? "" : String(content);
}

function buildPromptText(session) {
  const selectedTerms = getAnswerWithCustom(session, "candidate_terms", "multi");
  const outputFormat = getAnswerWithCustom(session, "output_format", "single") || "待确认";
  const bilingual = getAnswerWithCustom(session, "bilingual_synonym", "boolean");
  const constraints = getAnswerWithCustom(session, "constraints", "multi").join("；") || "无额外约束";
  const workflow = getWorkflowDefinition(session.workflow);
  const mergePolicy = getAnswerWithCustom(session, "merge_policy", "single") || "未指定";
  const synonymsConfirmed =
    bilingual === "yes" ? getSynonymEvidenceSummary(session) : "不强制做同义词归并";
  const refinementBlock = session.refinements.length
    ? `\n\n继续追问修改：\n${session.refinements.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
    : "";

  if (session.workflow === "synonym_merge") {
    return `你是材料术语标准化与同义词合并助手，请根据以下要求生成可审计的同义词合并结果。

原始需求参考：
${session.prompt || "待输入"}

流程类型：
${workflow.label}

合并目标：
${getAnswerWithCustom(session, "target_type", "single") || "待确认"}

待判断术语：
${selectedTerms.length ? selectedTerms.join("、") : "待用户补充"}

同义词确认结果：
${synonymsConfirmed}

合并策略：
${mergePolicy}

输出格式：
${outputFormat}

审计约束：
${constraints}

补充说明：
${getAnswerWithCustom(session, "extra_instructions", "text") || "无"}

知识证据：
${session.sourceMode === "rag" ? session.knowledge || "未提供详细知识片段。" : "基于通用领域模板组织候选。"}

执行规则：
1. 只有存在明确证据的同义词、别名、英文缩写、符号表达、又称、见/参见关系才能自动合并。
2. 相近但不完全等价的概念必须标记为待复核或同类相关，不能直接并入标准名。
3. 每个合并组至少输出：标准名、别名列表、关系类型、证据来源、证据原文、置信度、是否需要人工复核。
4. 明确列出“不应合并”的边界和原因。
5. 按“${outputFormat}”输出。${refinementBlock}`;
  }

  return `你是${getAnswerWithCustom(session, "business_role", "single") || "专业信息抽取助手"}，请根据以下要求从用户提供的文档中执行信息抽取。

原始需求参考：
${session.prompt || "待输入"}

流程类型：
${workflow.label}

任务场景：
${session.scenario ? session.scenario.label : "待识别"}

抽取目标：
${getAnswerWithCustom(session, "target_type", "single") || "待确认"}

重点候选词条：
${selectedTerms.length ? selectedTerms.join("、") : "待用户补充"}

输出格式要求：
${outputFormat}

术语标准化要求：
${bilingual === "yes" ? "需要英文附中文翻译，并合并同义词。" : "无需强制中英对照。"}
术语合并策略：
${mergePolicy}

同义词确认结果：
${synonymsConfirmed}

输出与质量约束：
${constraints}

补充说明：
${getAnswerWithCustom(session, "extra_instructions", "text") || "无"}

候选项来源：
${session.sourceMode === "rag" ? `优先参考附带术语片段：${session.knowledge || "未提供详细术语片段。"}` : "基于通用领域模板组织问答与候选词。"}

执行规则：
1. 仅基于待处理文档内容抽取，不要臆造文中没有的信息。
2. 先识别同义词、近义词、英文缩写和等价表达，再归并到标准词条。
3. 若出现英文术语，必须在同一字段中附带中文翻译。
4. 每条结果尽量保留原文证据句；无法判断时按约束输出空值或 null。
5. 按“${outputFormat}”输出，字段至少包含：标准词条、原文表述、同义/英文表达、证据句、备注。
6. 输出前检查去重、字段完整性和格式合法性。${refinementBlock}`;
}

function serializeSession(session) {
  return {
    id: session.id,
    prompt: session.prompt,
    workflow: session.workflow,
    workflowLabel: getWorkflowDefinition(session.workflow).label,
    sourceMode: session.sourceMode,
    model: session.model,
    knowledge: session.knowledge,
    scenario: session.scenario,
    knowledgeProfile: session.knowledgeProfile,
    questionSource: session.questionSource,
    promptSource: session.promptSource,
    currentIndex: session.currentIndex,
    currentQuestion: getCurrentQuestion(session),
    isComplete: session.currentIndex >= session.questions.length - 1 && Boolean(session.finalPrompt),
    questions: session.questions,
    answers: session.answers,
    customAnswers: session.customAnswers,
    autoAnswers: session.autoAnswers,
    refinements: session.refinements,
    finalPrompt: session.finalPrompt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function createOrchestrator({ callLLM, defaultModel, storage }) {
  const sessions = new Map();
  const store = storage || {};

  function persistSession(session, eventType, detail = {}) {
    const serialized = serializeSession(session);
    if (typeof store.saveSession === "function") {
      store.saveSession(serialized);
    }
    if (typeof store.appendAudit === "function") {
      store.appendAudit({
        type: eventType,
        sessionId: session.id,
        workflow: session.workflow,
        sourceMode: session.sourceMode,
        detail,
      });
    }
    return serialized;
  }

  function requireSession(id) {
    const memorySession = sessions.get(id);
    if (memorySession) return memorySession;

    if (typeof store.loadSession === "function") {
      const loaded = store.loadSession(id);
      if (loaded) {
        sessions.set(id, loaded);
        return loaded;
      }
    }

    const error = new Error("session not found.");
    error.statusCode = 404;
    throw error;
  }

  async function createSession(input) {
    const prompt = String(input.prompt || "").trim();
    if (!prompt) {
      const error = new Error("prompt is required.");
      error.statusCode = 400;
      throw error;
    }

    const sourceMode = input.sourceMode === "rag" ? "rag" : "generic";
    const workflow = WORKFLOW_DEFINITIONS[input.workflow] ? input.workflow : "field_template";
    const questionMode = input.questionMode === "llm" ? "llm" : "local";
    const model = input.model || defaultModel;
    const knowledge = String(input.knowledge || "").trim();
    const scenario = inferScenario(prompt);
    const knowledgeProfile = sourceMode === "rag" ? parseKnowledgeProfile(knowledge, scenario) : null;
    const baseQuestions = withExplicitCandidateTerms(buildQuestions({ sourceMode, scenario, knowledgeProfile, workflow }), prompt, knowledgeProfile);

    let questions = baseQuestions;
    let questionSource = { type: "本地模板", detail: "后端编排器" };

    if (questionMode === "llm") {
      const content = normalizeLLMContent(await callLLM({
        model,
        jsonMode: true,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content:
              "你是 RAG 智能体问答系统的后端问答编排器。必须只返回 JSON，不要返回 Markdown。保持问题 id、type、stepId 不变，只优化标题、描述、选项和占位符。若原始需求或知识片段中出现明确术语、字段名、英文缩写或符号表达，candidate_terms 的选项必须优先包含这些显式项，不得只保留通用模板候选。",
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                task: "根据用户模糊提示词生成澄清问答流程",
                raw_prompt: prompt,
                source_mode: sourceMode,
                workflow,
                workflow_label: getWorkflowDefinition(workflow).label,
                explicit_terms_from_prompt: extractExplicitTerms(prompt),
                knowledge,
                inferred_scenario: scenario,
                base_questions: baseQuestions,
                output_schema: {
                  scenario_label: "string",
                  questions: "array of questions with existing id, title, description, category, options",
                },
              },
              null,
              2
            ),
          },
        ],
      }));
      const payload = extractJsonObject(content);
      if (payload.scenario_label) scenario.label = String(payload.scenario_label);
      questions = withExplicitCandidateTerms(normalizeLLMQuestions(baseQuestions, payload.questions), prompt, knowledgeProfile);
      questionSource = { type: "LLM 生成", detail: model };
    }

    const now = new Date().toISOString();
    const autoAnswers = inferAutoAnswers({ prompt, workflow, questions });
    const answers = getDefaultAnswers(questions);
    Object.entries(autoAnswers).forEach(([questionId, item]) => {
      answers[questionId] = item.answer;
    });
    const session = {
      id: crypto.randomUUID(),
      prompt,
      workflow,
      sourceMode,
      model,
      knowledge,
      scenario,
      knowledgeProfile,
      questions,
      answers,
      customAnswers: getDefaultCustomAnswers(questions),
      autoAnswers,
      currentIndex: 0,
      refinements: [],
      finalPrompt: "",
      questionSource,
      promptSource: { type: "本地模板", detail: "实时预览" },
      createdAt: now,
      updatedAt: now,
    };
    moveToFirstUnskippedQuestion(session);
    sessions.set(session.id, session);
    return persistSession(session, "create_session", { questionMode, questionCount: session.questions.length });
  }

  function getSession(id) {
    const session = requireSession(id);
    return serializeSession(session);
  }

  function submitAnswer(id, input) {
    const session = requireSession(id);
    const question = getCurrentQuestion(session);
    const questionId = input.questionId || question?.id;
    if (!question || question.id !== questionId) {
      const error = new Error("questionId does not match current question.");
      error.statusCode = 409;
      throw error;
    }

    session.answers[question.id] = input.answer ?? session.answers[question.id];
    if (question.type !== "text") session.customAnswers[question.id] = input.customAnswer || "";
    if (question.type === "multi") {
      session.answers[question.id] = [...new Set([...(Array.isArray(session.answers[question.id]) ? session.answers[question.id] : []), ...parseCustomItems(session.customAnswers[question.id])])];
    }

    advanceToNextQuestion(session);
    session.promptSource = { type: "本地模板", detail: "实时预览" };
    session.finalPrompt = "";
    session.updatedAt = new Date().toISOString();
    return persistSession(session, "submit_answer", { questionId: question.id });
  }

  function navigateSession(id, input) {
    const session = requireSession(id);

    if (input.direction === "previous") {
      moveToPreviousQuestion(session);
    } else if (input.direction === "next") {
      advanceToNextQuestion(session);
    } else if (Number.isInteger(input.currentIndex)) {
      session.currentIndex = Math.max(0, Math.min(input.currentIndex, session.questions.length - 1));
      if (shouldSkipQuestion(session, session.questions[session.currentIndex])) {
        advanceToNextQuestion(session);
      }
    } else {
      const error = new Error("direction or currentIndex is required.");
      error.statusCode = 400;
      throw error;
    }

    session.finalPrompt = "";
    session.promptSource = { type: "本地模板", detail: "实时预览" };
    session.updatedAt = new Date().toISOString();
    return persistSession(session, "navigate_session", { direction: input.direction || "", currentIndex: session.currentIndex });
  }

  async function finalizeSession(id, input = {}) {
    const session = requireSession(id);
    const refinement = String(input.refinement || "").trim();
    if (refinement) session.refinements.push(refinement);

    const promptMode = input.promptMode === "llm" ? "llm" : "local";
    if (promptMode === "llm") {
      const content = normalizeLLMContent(await callLLM({
        model: input.model || session.model || defaultModel,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "你是严谨的信息抽取提示词工程师。请直接输出最终可执行提示词，不要解释过程。",
          },
          {
            role: "user",
            content: JSON.stringify(
              {
                raw_prompt: session.prompt,
                workflow: session.workflow,
                workflow_label: getWorkflowDefinition(session.workflow).label,
                source_mode: session.sourceMode,
                knowledge: session.knowledge,
                scenario: session.scenario,
                answers: session.answers,
                custom_answers: session.customAnswers,
                refinements: session.refinements,
                local_prompt_draft: buildPromptText(session),
              },
              null,
              2
            ),
          },
        ],
      }));
      session.finalPrompt = content.trim() || buildPromptText(session);
      session.promptSource = { type: "LLM 归纳", detail: input.model || session.model || defaultModel };
    } else {
      session.finalPrompt = buildPromptText(session);
      session.promptSource = { type: "本地模板", detail: "后端规则归纳" };
    }
    session.updatedAt = new Date().toISOString();
    const serialized = persistSession(session, "finalize_session", { promptMode, promptSource: session.promptSource });
    if (typeof store.appendPromptVersion === "function") {
      store.appendPromptVersion({
        sessionId: session.id,
        versionId: crypto.randomUUID(),
        workflow: session.workflow,
        sourceMode: session.sourceMode,
        promptMode,
        promptSource: session.promptSource,
        prompt: session.prompt,
        knowledge: session.knowledge,
        knowledgeProfile: session.knowledgeProfile,
        answers: session.answers,
        customAnswers: session.customAnswers,
        autoAnswers: session.autoAnswers,
        refinements: session.refinements,
        finalPrompt: session.finalPrompt,
        createdAt: session.updatedAt,
      });
    }
    return serialized;
  }

  return {
    createSession,
    getSession,
    listSessions: () => (typeof store.listSessions === "function" ? store.listSessions() : [...sessions.values()].map(serializeSession)),
    listPromptVersions: (sessionId) => (typeof store.listPromptVersions === "function" ? store.listPromptVersions(sessionId) : []),
    submitAnswer,
    navigateSession,
    finalizeSession,
    _sessions: sessions,
  };
}

module.exports = {
  createOrchestrator,
};
