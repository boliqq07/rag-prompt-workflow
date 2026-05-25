const FLOW_STEPS = [
  {
    id: "role",
    title: "角色与背景",
    description: "确定业务身份与任务语境",
  },
  {
    id: "target",
    title: "抽取目标",
    description: "确认本次要抽取的词条范围",
  },
  {
    id: "synonym",
    title: "术语确认",
    description: "确认同义词与标准名称",
  },
  {
    id: "format",
    title: "输出格式",
    description: "约束结构、证据与空值策略",
  },
  {
    id: "finalize",
    title: "最终修改",
    description: "补充额外说明并生成提示词",
  },
];

const WORKFLOW_DEFINITIONS = {
  field_template: {
    label: "抽取字段清单",
    description: "从抽取需求出发，确认字段、术语、格式和质量约束。",
    steps: FLOW_STEPS,
  },
  synonym_merge: {
    label: "同义词合并规则",
    description: "作为专门工具，只围绕术语簇、证据来源和合并边界生成标准化规则。",
    steps: [
      { id: "target", title: "合并范围", description: "确认要合并的术语集合与应用场景" },
      { id: "synonym", title: "术语证据", description: "确认同义、别名、参见关系和不应合并项" },
      { id: "format", title: "合并规则", description: "约束证据、置信度、标准名和输出格式" },
      { id: "finalize", title: "最终修改", description: "补充边界条件并生成合并提示词" },
    ],
  },
  prompt_generation: {
    label: "生成可执行提示词",
    description: "围绕最终 prompt 的目标、术语合并、输入、输出和约束进行确认。",
    steps: [
      { id: "role", title: "使用场景", description: "确定模型角色与 prompt 用途" },
      { id: "target", title: "任务目标", description: "确认待处理文档、任务边界和输入变量" },
      { id: "synonym", title: "术语确认", description: "确认同义词、相关项和禁止合并边界" },
      { id: "format", title: "输出约束", description: "确认输出结构、证据要求和失败策略" },
      { id: "finalize", title: "最终修改", description: "补充措辞偏好并生成提示词" },
    ],
  },
};

const GENERIC_LIBRARY = {
  steel: {
    label: "钢结构性能抽取",
    roles: ["通用数据工程师", "材料数据抽取员", "标准审核人员", "研究助理"],
    targets: ["性能词条", "构件类型", "连接方式", "病害与缺陷", "防护与加固措施"],
    candidateTerms: [
      "强度",
      "刚度",
      "稳定性",
      "延性",
      "韧性",
      "耐火性",
      "耐久性",
      "抗震性",
      "抗腐蚀性",
      "疲劳性能",
      "屈服性能",
      "承载能力",
    ],
    constraints: [
      "保留原文证据句",
      "输出术语出现位置",
      "同义词合并去重",
      "给出字段置信度",
      "无法判断时输出 null",
      "保留中英文对照",
    ],
    outputFormats: ["JSON 数组", "Markdown 表格", "CSV 字段", "三元组列表"],
  },
  corrosion: {
    label: "腐蚀信息抽取",
    roles: ["腐蚀数据工程师", "材料测试分析员", "标准审核人员", "研究助理"],
    targets: ["腐蚀类型", "腐蚀产物", "环境因素", "试验条件", "评价指标"],
    candidateTerms: [
      "点蚀",
      "缝隙腐蚀",
      "晶间腐蚀",
      "应力腐蚀",
      "腐蚀速率",
      "腐蚀电位",
      "失重",
      "温度",
      "氯离子浓度",
      "pH 值",
    ],
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

let synonymDictionary = {};

const EVIDENCE_GRADE = {
  A: "A 级：证据强，可自动合并",
  B: "B 级：建议合并，需保留证据",
  C: "C 级：相关术语，不自动合并",
  D: "D 级：禁止合并",
};

function classifyEvidence({ evidenceType = "llm_inferred", grade = "" } = {}) {
  if (grade) return grade;
  if (["excel_includes_parameter", "dictionary_alias", "dictionary_see_also"].includes(evidenceType)) return "A";
  if (["bilingual_alias", "abbreviation"].includes(evidenceType)) return "B";
  if (evidenceType === "related_only") return "C";
  if (["field_type_conflict", "metric_type_conflict", "semantic_boundary_conflict", "category_type_conflict"].includes(evidenceType)) return "D";
  return "B";
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

function makeSynonymValue(group) {
  return `${group.grade || "B"}|${group.canonical} => ${(group.aliases || []).join(" / ")}`;
}

function makeSynonymDescription(group) {
  return [
    EVIDENCE_GRADE[group.grade] || EVIDENCE_GRADE.B,
    group.evidenceType ? `证据类型：${group.evidenceType}` : "",
    group.evidenceText ? `证据：${group.evidenceText}` : "",
  ]
    .filter(Boolean)
    .join("；");
}

const state = {
  workflow: "prompt_generation",
  mode: "generic",
  model: "qwen3.6-plus",
  prompt: "",
  knowledge: "",
  knowledgeProfile: null,
  knowledgeAvailable: false,
  knowledgeStatusDetail: "尚未检测",
  knowledgeDbPath: "",
  knowledgeDbModifiedAt: "",
  knowledgeInspectError: "",
  knowledgeSources: [],
  selectedKnowledgeSourceIds: [],
  retrievedKnowledge: [],
  manualKnowledge: "",
  scenario: null,
  questions: [],
  answers: {},
  customAnswers: {},
  orchestratorSessionId: "",
  orchestratorEnabled: false,
  currentIndex: 0,
  finalPrompt: "",
  refinements: [],
  previewFormat: "text",
  history: [],
  uploadedDocuments: [],
  promptVersions: [],
  auditLogs: [],
  questionSource: "本地模板",
  questionSourceDetail: "尚未生成",
  promptSource: "本地模板",
  promptSourceDetail: "实时预览",
  llmConfigured: false,
  llmBusy: false,
  uploadBusy: false,
  lastHealthCheckAt: 0,
};

async function loadSynonymExamples() {
  try {
    const response = await fetch("./config/synonym_examples.json", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    synonymDictionary = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  } catch (_error) {
    synonymDictionary = {};
  }
}

const elements = {
  modeLabel: document.querySelector("#modeLabel"),
  previewStageLabel: document.querySelector("#previewStageLabel"),
  stageLabel: document.querySelector("#stageLabel"),
  stageDesc: document.querySelector("#stageDesc"),
  promptInput: document.querySelector("#promptInput"),
  knowledgeInput: document.querySelector("#knowledgeInput"),
  knowledgeField: document.querySelector("#knowledgeField"),
  modeSwitch: document.querySelector("#modeSwitch"),
  modelSelect: document.querySelector("#modelSelect"),
  llmConfigCard: document.querySelector("#llmConfigCard"),
  llmStatusTitle: document.querySelector("#llmStatusTitle"),
  llmStatusText: document.querySelector("#llmStatusText"),
  llmBaseUrlInput: document.querySelector("#llmBaseUrlInput"),
  llmApiKeyInput: document.querySelector("#llmApiKeyInput"),
  rememberLlmConfigInput: document.querySelector("#rememberLlmConfigInput"),
  saveLlmConfigBtn: document.querySelector("#saveLlmConfigBtn"),
  llmConfigStatus: document.querySelector("#llmConfigStatus"),
  generateBtn: document.querySelector("#generateBtn"),
  llmGenerateBtn: document.querySelector("#llmGenerateBtn"),
  resetBtn: document.querySelector("#resetBtn"),
  progressPill: document.querySelector("#progressPill"),
  questionStepLabel: document.querySelector("#questionStepLabel"),
  emptyState: document.querySelector("#emptyState"),
  questionnaire: document.querySelector("#questionnaire"),
  questionMeta: document.querySelector("#questionMeta"),
  questionCard: document.querySelector("#questionCard"),
  prevBtn: document.querySelector("#prevBtn"),
  nextBtn: document.querySelector("#nextBtn"),
  skipBtn: document.querySelector("#skipBtn"),
  confirmBtn: document.querySelector("#confirmBtn"),
  summaryCards: document.querySelector("#summaryCards"),
  previewOutput: document.querySelector("#previewOutput"),
  refineInput: document.querySelector("#refineInput"),
  refineBtn: document.querySelector("#refineBtn"),
  llmPromptBtn: document.querySelector("#llmPromptBtn"),
  downloadBtn: document.querySelector("#downloadBtn"),
  stepList: document.querySelector("#stepList"),
  sourceBadge: document.querySelector("#sourceBadge"),
  scenarioBadge: document.querySelector("#scenarioBadge"),
  knowledgeStatusTitle: document.querySelector("#knowledgeStatusTitle"),
  knowledgeStatusText: document.querySelector("#knowledgeStatusText"),
  knowledgeSourceList: document.querySelector("#knowledgeSourceList"),
  knowledgeFileInput: document.querySelector("#knowledgeFileInput"),
  knowledgeFileName: document.querySelector("#knowledgeFileName"),
  uploadKnowledgeBtn: document.querySelector("#uploadKnowledgeBtn"),
  uploadKnowledgeStatus: document.querySelector("#uploadKnowledgeStatus"),
  uploadedDocumentList: document.querySelector("#uploadedDocumentList"),
  historyList: document.querySelector("#historyList"),
  promptVersionList: document.querySelector("#promptVersionList"),
  auditLogList: document.querySelector("#auditLogList"),
  previewFormatSwitch: document.querySelector("#previewFormatSwitch"),
  todayLabel: document.querySelector("#todayLabel"),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatList(items, fallback = "待确认") {
  return items && items.length ? items.join("、") : fallback;
}

function setLLMBusy(isBusy, busyLabel = "LLM 调用中") {
  state.llmBusy = isBusy;
  elements.llmGenerateBtn.disabled = isBusy || !state.llmConfigured;
  elements.llmPromptBtn.disabled = isBusy || !state.llmConfigured;
  elements.llmGenerateBtn.textContent = isBusy ? busyLabel : "模型生成问题流";
  elements.llmPromptBtn.textContent = isBusy ? busyLabel : "LLM 生成提示词";
}

function setLLMStatus(title, text, configured = false) {
  state.llmConfigured = configured;
  elements.llmStatusTitle.textContent = title;
  elements.llmStatusText.textContent = text;
  elements.llmConfigCard.classList.toggle("is-connected", configured);
  elements.llmConfigCard.classList.toggle("is-disconnected", !configured);
  setLLMBusy(false);
}

function isServerBackedPage() {
  return window.location.protocol === "http:" || window.location.protocol === "https:";
}

function ensureModelOption(model) {
  if (!model) {
    return;
  }
  const exists = [...elements.modelSelect.options].some((option) => option.value === model);
  if (!exists) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    elements.modelSelect.appendChild(option);
  }
  elements.modelSelect.value = model;
  state.model = model;
}

function syncLLMConfigForm(config) {
  const llm = config?.llm || config || {};
  if (llm.baseUrl) elements.llmBaseUrlInput.value = llm.baseUrl;
  if (llm.model) ensureModelOption(llm.model);
  if (llm.apiKeyPreview) {
    elements.llmApiKeyInput.placeholder = `已配置 ${llm.apiKeyPreview}；留空保留`;
  } else {
    elements.llmApiKeyInput.placeholder = "留空则保留当前 Key";
  }
  elements.rememberLlmConfigInput.checked = Boolean(llm.saved);
}

async function loadLLMConfig() {
  if (!isServerBackedPage()) return;
  try {
    const payload = await apiJson("/api/config");
    syncLLMConfigForm(payload);
    return payload;
  } catch (_error) {
    elements.llmConfigStatus.textContent = "无法读取本机 API 设置";
    return null;
  }
}

async function saveLLMConfig() {
  if (!isServerBackedPage()) {
    elements.llmConfigStatus.textContent = "请通过 http://127.0.0.1:8080/ 打开后再保存";
    return;
  }

  elements.saveLlmConfigBtn.disabled = true;
  elements.saveLlmConfigBtn.textContent = "保存中";
  elements.llmConfigStatus.textContent = "正在更新本机后端配置";
  try {
    const payload = await apiJson("/api/config/llm", {
      method: "POST",
      body: {
        baseUrl: elements.llmBaseUrlInput.value.trim(),
        model: elements.modelSelect.value.trim(),
        apiKey: elements.llmApiKeyInput.value.trim(),
        remember: elements.rememberLlmConfigInput.checked,
      },
    });
    elements.llmApiKeyInput.value = "";
    syncLLMConfigForm(payload);
    elements.llmConfigStatus.textContent = payload.llm?.apiKeyConfigured
      ? `已保存：${payload.llm.model} / ${payload.llm.baseUrl}`
      : "已保存，但 API Key 仍未配置";
    await checkLLMHealth(true);
  } catch (error) {
    elements.llmConfigStatus.textContent = error.message || "保存失败";
  } finally {
    elements.saveLlmConfigBtn.disabled = false;
    elements.saveLlmConfigBtn.textContent = "保存 API 设置";
  }
}

function getGenerationSourceText(kind) {
  if (kind === "question") {
    return `${state.questionSource} · ${state.questionSourceDetail}`;
  }
  return `${state.promptSource} · ${state.promptSourceDetail}`;
}

function getWorkflowDefinition() {
  return WORKFLOW_DEFINITIONS[state.workflow] || WORKFLOW_DEFINITIONS.prompt_generation;
}

function getFlowSteps() {
  return getWorkflowDefinition().steps;
}

function inferScenario(promptText) {
  const normalized = promptText.trim().toLowerCase();
  if (normalized.includes("钢结构") || normalized.includes("steel")) {
    return { domainKey: "steel", intent: "information_extraction", label: "钢结构性能抽取" };
  }
  if (normalized.includes("腐蚀") || normalized.includes("corrosion")) {
    return { domainKey: "corrosion", intent: "information_extraction", label: "腐蚀信息抽取" };
  }
  return { domainKey: "general", intent: "information_extraction", label: "通用信息抽取" };
}

function normalizeKnowledgeLine(line) {
  return line
    .replace(/^[\s\-*+•·\d.、)）]+/, "")
    .replace(/^(?:内容|text)[：:]\s*/i, "")
    .trim();
}

function parseKnowledgeProfile(text, scenario) {
  const library = GENERIC_LIBRARY[scenario.domainKey];
  const synonyms = {};
  const terms = [];
  const synonymGroups = [];
  let currentFieldName = "";

  function addSynonymGroup(canonical, aliases, evidence = {}) {
    const cleanCanonical = String(canonical || "").trim();
    const cleanAliases = [...new Set((aliases || []).map((item) => String(item || "").trim()).filter(Boolean))].filter(
      (item) => item !== cleanCanonical
    );
    if (!cleanCanonical || !cleanAliases.length) return;
    const evidenceType = evidence.evidenceType || "llm_inferred";
    const grade = classifyEvidence({ evidenceType, grade: evidence.grade });
    synonymGroups.push({
      canonical: cleanCanonical,
      aliases: cleanAliases,
      evidenceType,
      grade,
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

  text
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
        return;
      }

      const seeAlsoMatch = item.match(/^定义[：:]\s*(?:见|参见)(.+?)(?:[（(]|[。；;，,]|$)/);
      if (seeAlsoMatch && terms.length) {
        addSynonymGroup(seeAlsoMatch[1].trim(), [terms[terms.length - 1]], {
          evidenceType: "dictionary_see_also",
          evidenceText: item,
        });
        return;
      }

      if (item.includes("：") || item.includes(":")) {
        return;
      }

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
      const term = bilingualMatch
        ? bilingualMatch[2].trim()
        : reverseBilingualMatch
          ? reverseBilingualMatch[1].trim()
          : item.trim();
      const alias = bilingualMatch
        ? `${bilingualMatch[1].trim()}（${term}）`
        : reverseBilingualMatch
          ? `${reverseBilingualMatch[2].trim()}（${term}）`
          : "";

      if (term.length < 2 || term.length > 28) {
        return;
      }

      terms.push(term);
      if (alias) {
        synonyms[term] = [...(synonyms[term] || []), alias];
      }
    });

  const uniqueTerms = [...new Set(terms)];
  const candidateTerms = uniqueTerms.length >= 4 ? uniqueTerms.slice(0, 16) : library.candidateTerms;

  return {
    candidateTerms,
    synonyms,
    synonymGroups,
    sourceLabel: uniqueTerms.length >= 4 ? "RAG 术语片段" : "RAG 片段不足，回退通用模板",
  };
}

function getSynonymOptions(terms) {
  const normalizeAlias = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[：:'"“”‘’（）()[\]\s_\-]+/g, "")
      .trim();

  const selectedKeys = new Set(terms.map(normalizeAlias).filter(Boolean));
  const usedKeys = new Set();
  const options = [];

  (state.knowledgeProfile?.synonymGroups || []).forEach((group) => {
    const canonical = group.canonical;
    const aliases = Array.isArray(group.aliases) ? group.aliases : [];
    const members = [canonical, ...aliases];
    const memberKeys = members.map(normalizeAlias).filter(Boolean);
    if (!memberKeys.some((key) => selectedKeys.has(key))) return;
    if (memberKeys.some((key) => usedKeys.has(key))) return;

    const canonicalKey = normalizeAlias(canonical);
    const related = [...new Set(aliases)].filter((item) => normalizeAlias(item) && normalizeAlias(item) !== canonicalKey);
    if (!canonicalKey || !related.length) return;

    memberKeys.forEach((key) => usedKeys.add(key));
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
    const ragRelated = (state.knowledgeProfile && state.knowledgeProfile.synonyms[term]) || [];
    const related = [...new Set([...ragRelated, ...(synonymDictionary[term] || [])])].filter(
      (item) => normalizeAlias(item) && normalizeAlias(item) !== termKey && !usedKeys.has(normalizeAlias(item))
    );
    if (!related.length) return;
    [term, ...related].map(normalizeAlias).filter(Boolean).forEach((key) => usedKeys.add(key));
    const group = {
      canonical: term,
      aliases: related,
      evidenceType: "bilingual_alias",
      grade: "B",
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

function buildQuestions() {
  const library = GENERIC_LIBRARY[state.scenario.domainKey];
  const candidateTerms =
    state.mode === "rag" && state.knowledgeProfile ? state.knowledgeProfile.candidateTerms : library.candidateTerms;

  if (state.workflow === "synonym_merge") {
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
        description: state.mode === "rag" ? "候选项优先来自当前知识库召回；可以手动补充遗漏术语。" : "当前使用通用候选项；可以手动补充真实术语。",
        options: candidateTerms.map((item) => ({
          value: item,
          label: item,
          description: "纳入本轮同义词/别名合并判断。",
        })),
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
        placeholder: "例如：强度损失率和强度降低百分比可合并，但强度值和强度损失率不能合并。",
        required: false,
      },
    ];
  }

  if (state.workflow === "prompt_generation") {
    return [
      {
        id: "business_role",
        stepId: "role",
        type: "single",
        category: "使用场景",
        title: "这个提示词最终要让模型扮演什么角色？",
        description: "角色会影响最终 prompt 的语气、检查规则和专业边界。",
        options: library.roles.map((item) => ({
          value: item,
          label: item,
          description: `最终提示词会以${item}作为模型角色。`,
        })),
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
        options: candidateTerms.map((item) => ({
          value: item,
          label: item,
          description: "写入提示词的重点对象或字段范围。",
        })),
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
        options: library.outputFormats.map((item) => ({
          value: item,
          label: item,
          description: `要求被调用模型按照${item}输出。`,
        })),
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
      options: library.roles.map((item) => ({
        value: item,
        label: item,
        description: `后续问题会按 ${item} 的工作方式组织。`,
      })),
      required: true,
    },
    {
      id: "target_type",
      stepId: "target",
      type: "single",
      category: "抽取目标",
      title: "你希望系统聚焦抽取哪一类内容？",
      description: "这一步决定后续候选项与最终提示词的任务边界。",
      options: library.targets.map((item) => ({
        value: item,
        label: item,
        description: `将 ${item} 作为本次抽取的主目标。`,
      })),
      required: true,
    },
    {
      id: "candidate_terms",
      stepId: "target",
      type: "multi",
      category: "抽取目标",
      title: "请选择你希望纳入的候选词条",
      description: state.mode === "rag" ? "当前优先从附带术语片段中提取候选项，你可以多选确认。" : "当前基于通用模板组织候选项，你可以多选确认。",
      options: candidateTerms.map((item) => ({
        value: item,
        label: item,
        description: "选中后会写入提示词中的候选术语集合。",
      })),
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
      options: library.outputFormats.map((item) => ({
        value: item,
        label: item,
        description: `要求模型按照 ${item} 输出。`,
      })),
      required: true,
    },
    {
      id: "constraints",
      stepId: "format",
      type: "multi",
      category: "输出格式",
      title: "你还希望加入哪些约束？",
      description: "这些约束会体现在最终提示词的执行细节里。",
      options: library.constraints.map((item) => ({
        value: item,
        label: item,
        description: "作为抽取质量约束加入提示词。",
      })),
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

function extractJsonObject(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("LLM 未返回可解析的 JSON。");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

function normalizeLLMQuestions(baseQuestions, llmQuestions) {
  const llmMap = new Map(
    (Array.isArray(llmQuestions) ? llmQuestions : [])
      .filter((question) => question && question.id)
      .map((question) => [question.id, question])
  );

  return baseQuestions.map((baseQuestion) => {
    const llmQuestion = llmMap.get(baseQuestion.id);
    if (!llmQuestion) {
      return baseQuestion;
    }

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
          if (typeof option === "string") {
            return { value: option, label: option, description: "由 LLM 根据当前任务生成。" };
          }
          const value = String(option.value || option.label || "").trim();
          if (!value) {
            return null;
          }
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

async function callLLM(messages, { jsonMode = false, temperature = 0.2 } = {}) {
  const response = await fetch("/api/llm", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: state.model,
      messages,
      jsonMode,
      temperature,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.detail || "LLM 调用失败。");
  }
  return normalizeLLMContent(payload.content);
}

async function apiJson(path, { method = "GET", body } = {}) {
  if (!isServerBackedPage()) {
    throw new Error("当前页面是通过本地文件打开的，无法访问后端接口。请使用 http://127.0.0.1:8080/ 打开。");
  }
  const response = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.detail || "后端编排请求失败。");
  }
  return payload;
}

function extractTermsFromKnowledgeResults(results) {
  const terms = [];
  (Array.isArray(results) ? results : []).forEach((result) => {
    const text = String(result.text || "");
    let metadata = {};
    try {
      metadata = JSON.parse(result.metadata_json || "{}");
    } catch (_error) {
      metadata = {};
    }

    [metadata.field_name, metadata.section].filter(Boolean).forEach((item) => terms.push(String(item).trim()));
    [/字段:\s*([^\n]+)/g, /涵盖参数:\s*([^\n]+)/g, /列5:\s*([^\n]+)/g, /定义:\s*([^\n]+)/g].forEach((pattern) => {
      let match = pattern.exec(text);
      while (match) {
        String(match[1])
          .split(/[，,、;；/]/)
          .map((item) => item.replace(/[（(].*?[）)]/g, "").trim())
          .filter((item) => item.length >= 2 && item.length <= 28)
          .forEach((item) => terms.push(item));
        match = pattern.exec(text);
      }
    });
  });
  return [...new Set(terms)].slice(0, 20);
}

function cleanAliasToken(value) {
  return String(value || "")
    .replace(/^[\s"'‘’“”]+|[\s"'‘’“”，,。；;:：]+$/g, "")
    .trim();
}

function splitAliasList(value) {
  return String(value || "")
    .split(/(?:'\s*,\s*')|[,，、;；/|]/)
    .map(cleanAliasToken)
    .filter((item) => item.length >= 2 && item.length <= 64 && item !== "/");
}

function extractSynonymGroupsFromKnowledgeResults(results) {
  const groups = new Map();
  function addGroup(canonical, aliases, evidence) {
    const cleanCanonical = cleanAliasToken(canonical);
    const cleanAliases = splitAliasList(Array.isArray(aliases) ? aliases.join("；") : aliases).filter((item) => item !== cleanCanonical);
    if (!cleanCanonical || !cleanAliases.length) return;
    const previous = groups.get(cleanCanonical) || { aliases: [], evidenceType: evidence.evidenceType, evidenceText: evidence.evidenceText };
    groups.set(cleanCanonical, {
      aliases: [...new Set([...previous.aliases, ...cleanAliases])],
      evidenceType: previous.evidenceType || evidence.evidenceType,
      evidenceText: previous.evidenceText || evidence.evidenceText,
    });
  }

  (Array.isArray(results) ? results : []).forEach((result) => {
    let metadata = {};
    try {
      metadata = JSON.parse(result.metadata_json || "{}");
    } catch (_error) {
      metadata = {};
    }
    const text = String(result.text || "");
    const canonical = cleanAliasToken(metadata.field_name || (text.match(/字段:\s*([^\n]+)/) || [])[1] || "");
    const params = cleanAliasToken((text.match(/涵盖参数:\s*([^\n]+)/) || [])[1] || "");
    const aliases = splitAliasList(params).filter((item) => item !== canonical);
    if (canonical && aliases.length) {
      addGroup(canonical, aliases, { evidenceType: "excel_includes_parameter", evidenceText: `涵盖参数: ${params}` });
    }

    const term = cleanAliasToken(metadata.term || (text.match(/术语:\s*([^\n]+)/) || [])[1] || "");
    const definition = cleanAliasToken((text.match(/定义:\s*([^\n]+)/) || [])[1] || "");
    const aliasMatch = definition.match(/^又称(.+?)[。；;，,]/);
    if (term && aliasMatch) {
      addGroup(term, aliasMatch[1], { evidenceType: "dictionary_alias", evidenceText: `定义: ${definition}` });
    }
    const seeAlsoMatch = definition.match(/^(?:见|参见)(.+?)(?:[（(]|[。；;，,]|$)/);
    if (term && seeAlsoMatch) {
      addGroup(seeAlsoMatch[1], [term], { evidenceType: "dictionary_see_also", evidenceText: `定义: ${definition}` });
    }

    const bracketPattern = /([A-Za-z][A-Za-z0-9\s_\-/%.'σψ]+|[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9\s_\-/%.'σψ]{1,30})[（(]([^）)]{2,120})[）)]/g;
    let match = bracketPattern.exec(text);
    while (match) {
      const head = cleanAliasToken(match[1]);
      const related = splitAliasList(match[2]);
      if (head && related.length) {
        addGroup(head, related.filter((item) => item !== head), { evidenceType: "bilingual_alias", evidenceText: match[0] });
      }
      match = bracketPattern.exec(text);
    }
  });

  return [...groups.entries()]
    .map(([canonical, group]) => ({
      canonical,
      aliases: group.aliases.filter((item) => item !== canonical).slice(0, 10),
      evidenceType: group.evidenceType,
      evidenceText: group.evidenceText,
      grade: classifyEvidence({ evidenceType: group.evidenceType }),
    }))
    .filter((group) => group.aliases.length)
    .slice(0, 12);
}

function formatKnowledgeResults(results) {
  const terms = extractTermsFromKnowledgeResults(results);
  const synonymGroups = extractSynonymGroupsFromKnowledgeResults(results);
  const termBlock = terms.length ? `Milvus 检索术语候选：\n${terms.join("\n")}` : "";
  const synonymBlock = synonymGroups.length
    ? `Milvus 同义词组：\n${synonymGroups
        .map(
          (group) =>
            `同义词组：${group.canonical} => ${group.aliases.join("；")}（证据类型：${group.evidenceType}；证据等级：${group.grade}；证据文本：${group.evidenceText || ""}）`
        )
        .join("\n")}`
    : "";
  const sourceBlock = (Array.isArray(results) ? results : [])
    .map((result, index) => {
      const source = result.knowledge_source_label || (result.source_type === "excel" ? "Excel" : "标准平台网页");
      return [
        `Milvus 命中 ${index + 1}：`,
        `来源：${source}`,
        `标题：${result.title || "未命名"}`,
        `地址：${result.source_uri || ""}`,
        `内容：${String(result.text || "").slice(0, 280)}`,
      ].join("\n");
    })
    .join("\n\n");
  return [termBlock, synonymBlock, sourceBlock].filter(Boolean).join("\n\n");
}

function formatKnowledgeTime(value) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未记录";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getKnowledgeHealthClass(source) {
  if (source.health === "ready") return "ready";
  if (source.health === "unknown") return "unknown";
  return "missing";
}

async function refreshKnowledgeStatus() {
  try {
    if (!isServerBackedPage()) {
      state.knowledgeAvailable = false;
      state.knowledgeSources = [];
      state.selectedKnowledgeSourceIds = [];
      state.knowledgeDbPath = "";
      state.knowledgeDbModifiedAt = "";
      state.knowledgeInspectError = "";
      state.knowledgeStatusDetail = "当前通过本地文件打开，无法连接知识库接口；请使用 http://127.0.0.1:8080/ 打开。";
    } else {
      const payload = await apiJson("/api/knowledge/status");
      state.knowledgeAvailable = Boolean(payload.configured);
      state.knowledgeSources = Array.isArray(payload.sources) ? payload.sources : [];
      state.knowledgeDbPath = payload.dbPath || "";
      state.knowledgeDbModifiedAt = payload.dbModifiedAt || "";
      state.knowledgeInspectError = payload.inspectError || "";
      if (!state.selectedKnowledgeSourceIds.length && state.knowledgeSources.length) {
        const readySource = state.knowledgeSources.find((source) => source.health === "ready");
        state.selectedKnowledgeSourceIds = readySource ? [readySource.id] : [];
      } else {
        const availableIds = new Set(state.knowledgeSources.map((source) => source.id));
        state.selectedKnowledgeSourceIds = state.selectedKnowledgeSourceIds.filter((id) => availableIds.has(id));
      }
      const readyCount = state.knowledgeSources.filter((source) => source.health === "ready").length;
      state.knowledgeStatusDetail = state.knowledgeAvailable
        ? `可用知识库：${readyCount}/${state.knowledgeSources.length || 0} 个`
        : "尚未检测到可用知识源";
    }
  } catch (_error) {
    state.knowledgeAvailable = false;
    state.knowledgeStatusDetail = "知识库服务不可用";
    state.knowledgeDbPath = "";
    state.knowledgeDbModifiedAt = "";
    state.knowledgeInspectError = "";
  } finally {
    renderKnowledgeSourceList();
  }
  updateTopStatus();
  updateSummaryCards();
}

function getSelectedKnowledgeSources() {
  const selected = new Set(state.selectedKnowledgeSourceIds);
  return state.knowledgeSources.filter((source) => selected.has(source.id));
}

function renderKnowledgeSourceList() {
  if (!elements.knowledgeSourceList) return;
  if (!state.knowledgeSources.length) {
    elements.knowledgeSourceList.innerHTML = `<div class="history-item muted">暂无可选知识库</div>`;
    return;
  }
  const selected = new Set(state.selectedKnowledgeSourceIds);
  elements.knowledgeSourceList.innerHTML = state.knowledgeSources
    .map(
      (source) => {
        const sampleTitles = (source.sampleTitles || []).slice(0, 2).filter(Boolean);
        const meta = [
          `${Number(source.rowCount || 0)} chunks`,
          `更新 ${formatKnowledgeTime(source.lastUpdated || state.knowledgeDbModifiedAt)}`,
        ];
        if (source.sourceTypes?.length) meta.push(source.sourceTypes.join("/"));
        return `
          <label class="knowledge-source-option health-${escapeHtml(getKnowledgeHealthClass(source))}">
            <input
              type="checkbox"
              name="knowledgeSource"
              value="${escapeHtml(source.id)}"
              ${selected.has(source.id) ? "checked" : ""}
              ${source.health === "ready" ? "" : "disabled"}
            />
            <span>
              <b>${escapeHtml(source.label)}</b>
              <em>${escapeHtml(source.healthLabel || "未知")}</em>
              <small>${escapeHtml(source.collection)}</small>
              <small>${escapeHtml(meta.join(" · "))}</small>
              <small>${escapeHtml(source.healthMessage || "")}</small>
              ${
                sampleTitles.length
                  ? `<small>样例：${sampleTitles.map((title) => escapeHtml(title)).join("；")}</small>`
                  : ""
              }
            </span>
          </label>
        `;
      }
    )
    .join("");
}

function renderUploadedDocuments() {
  if (!elements.uploadedDocumentList) return;
  if (!state.uploadedDocuments.length) {
    elements.uploadedDocumentList.innerHTML = "";
    return;
  }
  elements.uploadedDocumentList.innerHTML = state.uploadedDocuments
    .slice(-5)
    .reverse()
    .map((document) => {
      const milvusText = document.milvusStatus?.inserted
        ? `Milvus ${document.milvusStatus.inserted} 条`
        : document.milvusStatus?.error
          ? "Milvus 失败，本地兜底"
          : "待索引";
      return `
        <div class="document-item">
          <span>
            <strong>${escapeHtml(document.filename)}</strong>
            <small>${Number(document.chunkCount || 0)} chunks · ${milvusText}</small>
          </span>
          <button class="danger-text-btn" type="button" data-delete-upload="${escapeHtml(document.id)}">删除</button>
        </div>
      `;
    })
    .join("");
}

async function loadUploadedDocuments() {
  if (!isServerBackedPage()) return;
  const payload = await apiJson("/api/knowledge/uploads");
  state.uploadedDocuments = Array.isArray(payload.documents) ? payload.documents : [];
  renderUploadedDocuments();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
    reader.readAsDataURL(blob);
  });
}

async function fileToUploadPayload(file) {
  const textExtensions = /\.(txt|md|markdown|csv|json|log|html?|xml)$/i;
  if (textExtensions.test(file.name)) {
    return {
      filename: file.name,
      mimeType: file.type || "text/plain",
      content: await file.text(),
    };
  }
  return {
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    dataBase64: await blobToBase64(file),
  };
}

async function uploadKnowledgeFiles() {
  const files = [...(elements.knowledgeFileInput?.files || [])];
  if (!files.length) {
    elements.uploadKnowledgeStatus.textContent = "请先选择一个文本文件";
    return;
  }
  if (!isServerBackedPage()) {
    elements.uploadKnowledgeStatus.textContent = "请通过 http://127.0.0.1:8080/ 打开后再上传";
    return;
  }

  state.uploadBusy = true;
  elements.uploadKnowledgeBtn.disabled = true;
  elements.uploadKnowledgeBtn.textContent = "上传中";
  elements.uploadKnowledgeStatus.textContent = `正在处理 ${files.length} 个文件`;

  try {
    const payload = {
      files: await Promise.all(
        files.map((file) => fileToUploadPayload(file))
      ),
    };
    const result = await apiJson("/api/knowledge/uploads", {
      method: "POST",
      body: payload,
    });
    const uploaded = result.uploaded || [];
    elements.uploadKnowledgeStatus.textContent = uploaded.length
      ? `已上传 ${uploaded.length} 个文件，生成 ${uploaded.reduce((sum, item) => sum + Number(item.chunkCount || 0), 0)} 个向量片段`
      : "没有生成可检索片段";
    elements.knowledgeFileInput.value = "";
    elements.knowledgeFileName.textContent = "未选择文件";
    await refreshKnowledgeStatus();
    await loadUploadedDocuments();
    await loadAuditLogs();
    state.selectedKnowledgeSourceIds = [...new Set([...state.selectedKnowledgeSourceIds, "uploaded_documents"])];
    state.mode = "rag";
    elements.knowledgeField.classList.remove("hidden");
    [...elements.modeSwitch.querySelectorAll(".mode-btn")].forEach((item) =>
      item.classList.toggle("active", item.dataset.mode === "rag")
    );
    renderKnowledgeSourceList();
    updateTopStatus();
  } catch (error) {
    elements.uploadKnowledgeStatus.textContent = error.message || "上传失败";
  } finally {
    state.uploadBusy = false;
    elements.uploadKnowledgeBtn.disabled = false;
    elements.uploadKnowledgeBtn.textContent = "上传文档";
  }
}

function updateSelectedFileName() {
  const files = [...(elements.knowledgeFileInput?.files || [])];
  if (!files.length) {
    elements.knowledgeFileName.textContent = "未选择文件";
    return;
  }
  elements.knowledgeFileName.textContent =
    files.length === 1 ? files[0].name : `${files[0].name} 等 ${files.length} 个文件`;
}

async function deleteUploadedDocument(documentId) {
  if (!documentId || !isServerBackedPage()) return;
  await apiJson(`/api/knowledge/uploads/${encodeURIComponent(documentId)}`, { method: "DELETE" });
  await loadUploadedDocuments();
  await refreshKnowledgeStatus();
  await loadAuditLogs();
}

async function hydrateKnowledgeFromMilvus() {
  if (state.mode !== "rag") {
    state.retrievedKnowledge = [];
    state.manualKnowledge = elements.knowledgeInput.value.trim();
    state.knowledge = state.manualKnowledge;
    return;
  }

  const selectedSources = getSelectedKnowledgeSources();
  if (!selectedSources.length) {
    throw new Error("请至少选择一个知识库作为知识源。");
  }

  state.manualKnowledge = elements.knowledgeInput.value.trim();
  elements.stageLabel.textContent = "正在检索 RAG 知识库";
  elements.stageDesc.textContent = `系统会从 ${selectedSources.map((source) => source.label).join("、")} 中召回知识片段。`;
  const payload = await apiJson("/api/knowledge/search", {
    method: "POST",
    body: {
      query: state.prompt,
      collections: state.selectedKnowledgeSourceIds,
      limit: 8,
    },
  });

  state.retrievedKnowledge = payload.results || [];
  const retrievedText = formatKnowledgeResults(state.retrievedKnowledge);
  state.knowledge = [retrievedText, state.manualKnowledge ? `人工补充术语片段\n${state.manualKnowledge}` : ""]
    .filter(Boolean)
    .join("\n\n");
  elements.knowledgeInput.value = state.knowledge;
  state.knowledgeProfile = state.scenario ? parseKnowledgeProfile(state.knowledge, state.scenario) : state.knowledgeProfile;
  updateTopStatus();
  updateSummaryCards();
}

function syncFromOrchestratorSession(session) {
  state.orchestratorSessionId = session.id || "";
  state.orchestratorEnabled = Boolean(session.id);
  state.workflow = session.workflow || state.workflow || "field_template";
  state.prompt = session.prompt || state.prompt;
  state.mode = session.sourceMode || state.mode;
  state.model = session.model || state.model;
  state.knowledge = session.knowledge || state.knowledge;
  state.knowledgeProfile = session.knowledgeProfile || null;
  state.scenario = session.scenario || null;
  state.questions = session.questions || [];
  state.answers = session.answers || {};
  state.customAnswers = session.customAnswers || {};
  state.currentIndex = Number.isInteger(session.currentIndex) ? session.currentIndex : 0;
  state.finalPrompt = session.finalPrompt || "";
  state.refinements = session.refinements || [];
  state.questionSource = session.questionSource?.type || "后端编排";
  state.questionSourceDetail = session.questionSource?.detail || "Orchestrator";
  state.promptSource = session.promptSource?.type || "本地模板";
  state.promptSourceDetail = session.promptSource?.detail || "实时预览";

  elements.promptInput.value = state.prompt;
  elements.knowledgeInput.value = state.knowledge;
  elements.knowledgeField.classList.toggle("hidden", state.mode !== "rag");
  [...elements.modeSwitch.querySelectorAll(".mode-btn")].forEach((item) =>
    item.classList.toggle("active", item.dataset.mode === state.mode)
  );

  elements.emptyState.classList.add("hidden");
  elements.questionnaire.classList.remove("hidden");
  updateTopStatus();
  updateSummaryCards();
  renderStepList();
  renderHistory();
  renderQuestion();
  renderPreview();
}

async function createBackendSession(questionMode) {
  const session = await apiJson("/api/orchestrator/sessions", {
    method: "POST",
    body: {
      prompt: state.prompt,
      knowledge: state.knowledge,
      sourceMode: state.mode,
      workflow: state.workflow,
      questionMode,
      model: state.model,
    },
  });
  syncFromOrchestratorSession(session);
  await loadPersistedSessions();
  return session;
}

function generateQuestionnaireLocal() {
  state.scenario = inferScenario(state.prompt);
  state.knowledgeProfile =
    state.mode === "rag" ? parseKnowledgeProfile(state.knowledge, state.scenario) : null;
  state.questions = buildQuestions();
  state.answers = getDefaultAnswers(state.questions);
  state.customAnswers = getDefaultCustomAnswers(state.questions);
  state.orchestratorSessionId = "";
  state.orchestratorEnabled = false;
  state.currentIndex = 0;
  state.refinements = [];
  state.finalPrompt = "";
  state.questionSource = "本地模板";
  state.questionSourceDetail = `${getWorkflowDefinition().label} / 浏览器内置规则`;
  state.promptSource = "本地模板";
  state.promptSourceDetail = "实时预览";

  state.history.unshift({
    title: state.prompt.length > 20 ? `${state.prompt.slice(0, 20)}...` : state.prompt,
    subtitle: `本地模板 / ${state.scenario.label} / ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
  });

  elements.emptyState.classList.add("hidden");
  elements.questionnaire.classList.remove("hidden");

  updateTopStatus();
  updateSummaryCards();
  renderStepList();
  renderHistory();
  renderQuestion();
  renderPreview();
}

function getDefaultAnswers(questions) {
  const defaults = {};
  questions.forEach((question) => {
    if (question.type === "multi") {
      defaults[question.id] = [];
      return;
    }
    if (question.type === "boolean") {
      defaults[question.id] = "yes";
      return;
    }
    defaults[question.id] = "";
  });
  return defaults;
}

function getDefaultCustomAnswers(questions) {
  const defaults = {};
  questions.forEach((question) => {
    if (question.type !== "text") {
      defaults[question.id] = "";
    }
  });
  return defaults;
}

function parseCustomItems(value) {
  return String(value || "")
    .split(/[\n,，;；、|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getAnswerWithCustom(question) {
  const answer = state.answers[question.id];
  const customItems = parseCustomItems(state.customAnswers[question.id]);

  if (question.type === "multi") {
    return [...new Set([...(Array.isArray(answer) ? answer : []), ...customItems])];
  }

  if (question.type === "text") {
    return answer || "";
  }

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

function getSynonymEvidenceSummary() {
  const selected = getAnswerWithCustom({ id: "synonym_groups", type: "multi" }) || [];
  const question = state.questions.find((item) => item.id === "synonym_groups");
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

function refreshSynonymQuestion() {
  const question = state.questions.find((item) => item.id === "synonym_groups");
  if (!question) {
    return;
  }
  const selectedTerms = state.answers.candidate_terms || [];
  const fallbackTerms = GENERIC_LIBRARY[state.scenario ? state.scenario.domainKey : "general"].candidateTerms.slice(0, 3);
  question.options = getSynonymOptions(selectedTerms.length ? selectedTerms : fallbackTerms);
  if (!Array.isArray(state.answers.synonym_groups) || !state.answers.synonym_groups.length) {
    state.answers.synonym_groups = question.options.filter((option) => option.autoSelect && !option.disabled).map((option) => option.value);
  }
}

function getCurrentQuestion() {
  return state.questions[state.currentIndex];
}

function shouldSkipQuestion(question) {
  if (!question || question.id !== "synonym_groups") {
    return false;
  }
  refreshSynonymQuestion();
  return state.answers.bilingual_synonym === "no" || !question.options.length;
}

function moveToNextVisibleQuestion() {
  while (state.currentIndex < state.questions.length - 1) {
    state.currentIndex += 1;
    const nextQuestion = getCurrentQuestion();
    if (!shouldSkipQuestion(nextQuestion)) {
      return;
    }
    state.answers[nextQuestion.id] = [];
  }
}

function moveToPreviousVisibleQuestion() {
  while (state.currentIndex > 0) {
    state.currentIndex -= 1;
    if (!shouldSkipQuestion(getCurrentQuestion())) {
      return;
    }
  }
}

function getCurrentStepIndex() {
  const current = getCurrentQuestion();
  if (!current) {
    return -1;
  }
  return getFlowSteps().findIndex((step) => step.id === current.stepId);
}

function getStepAnswerState(stepId) {
  const stepQuestions = state.questions.filter((item) => item.stepId === stepId);
  if (!stepQuestions.length) {
    return "pending";
  }
  const fullyAnswered = stepQuestions.every((question) => {
    const answer = state.answers[question.id];
    if (question.type === "multi") {
      return !question.required || (Array.isArray(answer) && answer.length > 0);
    }
    return !question.required || Boolean(answer);
  });
  return fullyAnswered ? "done" : "pending";
}

function renderStepList() {
  const currentStepIndex = getCurrentStepIndex();
  elements.stepList.innerHTML = getFlowSteps().map((step, index) => {
    const answerState = getStepAnswerState(step.id);
    const classes = ["step-item"];
    if (index === currentStepIndex) {
      classes.push("active");
    }
    if (answerState === "done" && index < currentStepIndex + 1) {
      classes.push("done");
    }

    return `
      <div class="${classes.join(" ")}">
        <div class="step-index">${index + 1}</div>
        <div>
          <strong>${escapeHtml(step.title)}</strong>
          <p>${escapeHtml(step.description)}</p>
        </div>
      </div>
    `;
  }).join("");
}

function renderHistory() {
  if (!state.history.length) {
    elements.historyList.innerHTML = `<div class="history-item muted">尚未生成会话</div>`;
    return;
  }

  elements.historyList.innerHTML = state.history
    .slice(0, 5)
    .map(
      (item) => `
        <div class="history-item">
          <strong>${escapeHtml(item.title)}</strong><br />
          <span>${escapeHtml(item.subtitle)}</span>
          ${item.sessionId ? `<br /><button class="mini-btn" type="button" data-load-session="${escapeHtml(item.sessionId)}">恢复</button>` : ""}
        </div>
      `
    )
    .join("");
}

function renderPromptVersions() {
  if (!elements.promptVersionList) return;
  if (!state.promptVersions.length) {
    elements.promptVersionList.innerHTML = `<div class="history-item muted">尚未生成版本</div>`;
    return;
  }
  elements.promptVersionList.innerHTML = state.promptVersions
    .slice(0, 4)
    .map(
      (version) => `
        <div class="history-item">
          <strong>${escapeHtml(version.promptSource?.type || version.promptMode || "版本")}</strong><br />
          <span>${escapeHtml(formatKnowledgeTime(version.createdAt))} · ${escapeHtml(version.workflow || "")}</span>
        </div>
      `
    )
    .join("");
}

function renderAuditLogs() {
  if (!elements.auditLogList) return;
  if (!state.auditLogs.length) {
    elements.auditLogList.innerHTML = `<div class="history-item muted">暂无审计事件</div>`;
    return;
  }
  elements.auditLogList.innerHTML = state.auditLogs
    .slice(0, 5)
    .map(
      (event) => `
        <div class="history-item">
          <strong>${escapeHtml(event.type)}</strong><br />
          <span>${escapeHtml(formatKnowledgeTime(event.createdAt))}</span>
        </div>
      `
    )
    .join("");
}

async function loadPersistedSessions() {
  if (!isServerBackedPage()) return;
  const payload = await apiJson("/api/orchestrator/sessions");
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  state.history = sessions.map((session) => ({
    sessionId: session.id,
    title: session.prompt || "未命名会话",
    subtitle: `${session.workflow || "workflow"} / ${session.scenario?.label || "未识别"} / ${formatKnowledgeTime(session.updatedAt)}`,
  }));
  renderHistory();
}

async function loadPromptVersions(sessionId = state.orchestratorSessionId) {
  if (!sessionId || !isServerBackedPage()) {
    state.promptVersions = [];
    renderPromptVersions();
    return;
  }
  const payload = await apiJson(`/api/orchestrator/sessions/${encodeURIComponent(sessionId)}/prompt-versions`);
  state.promptVersions = Array.isArray(payload.versions) ? payload.versions : [];
  renderPromptVersions();
}

async function loadAuditLogs() {
  if (!isServerBackedPage()) return;
  const payload = await apiJson("/api/knowledge/audit-logs?limit=5");
  state.auditLogs = Array.isArray(payload.events) ? payload.events : [];
  renderAuditLogs();
}

async function restoreSession(sessionId) {
  const session = await apiJson(`/api/orchestrator/sessions/${encodeURIComponent(sessionId)}`);
  syncFromOrchestratorSession(session);
  await loadPromptVersions(sessionId);
}

function renderQuestion() {
  const question = getCurrentQuestion();
  if (!question) {
    return;
  }

  refreshSynonymQuestion();
  const currentStep = getFlowSteps()[getCurrentStepIndex()] || getFlowSteps()[0];
  const currentAnswer = state.answers[question.id];
  const currentCustom = state.customAnswers[question.id] || "";

  elements.questionStepLabel.textContent = `步骤 ${getCurrentStepIndex() + 1} · ${currentStep.title}`;
  elements.questionMeta.innerHTML = `
    <span>${question.category}</span>
    <span class="source-pill">${escapeHtml(getGenerationSourceText("question"))}</span>
    <span>${state.currentIndex + 1} / ${state.questions.length}</span>
  `;

  let controlHtml = "";

  if (question.type === "single" || question.type === "boolean") {
    controlHtml = `
      <div class="option-list">
        ${question.options
          .map(
            (option) => `
              <label class="option">
                <input
                  type="radio"
                  name="${escapeHtml(question.id)}"
                  value="${escapeHtml(option.value)}"
                  ${currentAnswer === option.value ? "checked" : ""}
                />
                <span>
                  <span class="option-title">${escapeHtml(option.label)}</span>
                  <span class="option-desc">${escapeHtml(option.description)}</span>
                </span>
              </label>
            `
          )
          .join("")}
        <label class="option custom-option">
          <input
            type="radio"
            name="${escapeHtml(question.id)}"
            value="__custom__"
            ${currentAnswer === "__custom__" ? "checked" : ""}
          />
          <span>
            <span class="option-title">自定义补充</span>
            <span class="option-desc">没有合适选项时，选择这里并在下方填写你的内容。</span>
          </span>
        </label>
      </div>
    `;
  }

  if (question.type === "multi") {
    controlHtml = `
      <div class="option-list">
        ${
          question.options.length
            ? question.options
                .map(
                  (option) => `
              <label class="option">
                <input
                  type="checkbox"
                  name="${escapeHtml(question.id)}"
                  value="${escapeHtml(option.value)}"
                  ${currentAnswer.includes(option.value) ? "checked" : ""}
                  ${option.disabled ? "disabled" : ""}
                />
                <span>
                  <span class="option-title">${option.grade ? `<b class="grade-pill grade-${escapeHtml(option.grade)}">${escapeHtml(option.grade)}</b>` : ""}${escapeHtml(option.label)}</span>
                  <span class="option-desc">${escapeHtml(option.description)}</span>
                </span>
              </label>
            `
                )
                .join("")
            : `<div class="option muted">当前没有可确认的候选别名，可以直接跳过。</div>`
        }
      </div>
    `;
  }

  if (question.type === "text") {
    controlHtml = `
      <textarea
        id="questionTextarea"
        rows="8"
        placeholder="${escapeHtml(question.placeholder || "")}"
      >${escapeHtml(currentAnswer)}</textarea>
    `;
  }

  elements.questionCard.innerHTML = `
    <span class="question-label">${escapeHtml(question.category)}</span>
    <h3>${escapeHtml(question.title)}</h3>
    <p>${escapeHtml(question.description)}</p>
    ${controlHtml}
    ${
      question.type !== "text"
        ? `
          <label class="custom-answer-field">
            <span>自行添加相关内容</span>
            <textarea
              id="customAnswerTextarea"
              rows="3"
              placeholder="可填写一个或多个补充项，用逗号、顿号或换行分隔。"
            >${escapeHtml(currentCustom)}</textarea>
          </label>
        `
        : ""
    }
  `;

  elements.progressPill.textContent = `${state.currentIndex + 1} / ${state.questions.length}`;
  elements.nextBtn.disabled = state.currentIndex >= state.questions.length - 1;
  elements.prevBtn.disabled = state.currentIndex === 0;
  elements.confirmBtn.textContent = state.currentIndex === state.questions.length - 1 ? "生成提示词" : "确认选择";

  elements.stageLabel.textContent = `第 ${getCurrentStepIndex() + 1} 步：${currentStep.title}`;
  elements.stageDesc.textContent = `${currentStep.description}。问答来源：${getGenerationSourceText("question")}。`;
  elements.previewStageLabel.textContent = currentStep.title;
  renderStepList();
}

function collectCurrentAnswer() {
  const question = getCurrentQuestion();
  if (!question) {
    return;
  }

  if (question.type === "single" || question.type === "boolean") {
    const checked = document.querySelector(`input[name="${question.id}"]:checked`);
    state.answers[question.id] = checked ? checked.value : "";
  }

  if (question.type === "multi") {
    const selected = [...document.querySelectorAll(`input[name="${question.id}"]:checked`)].map((input) => input.value);
    state.answers[question.id] = [...new Set([...selected, ...parseCustomItems(state.customAnswers[question.id])])];
  }

  if (question.type === "text") {
    const textarea = document.querySelector("#questionTextarea");
    state.answers[question.id] = textarea ? textarea.value.trim() : "";
  }

  if (question.type !== "text") {
    const customTextarea = document.querySelector("#customAnswerTextarea");
    state.customAnswers[question.id] = customTextarea ? customTextarea.value.trim() : "";
  }
}

function validateCurrentQuestion() {
  const question = getCurrentQuestion();
  if (!question || !question.required) {
    return true;
  }

  const answer = state.answers[question.id];
  const customItems = parseCustomItems(state.customAnswers[question.id]);
  if (question.type === "multi") {
    return (Array.isArray(answer) && answer.length > 0) || customItems.length > 0;
  }
  if (question.type === "single" || question.type === "boolean") {
    return Boolean(answer && answer !== "__custom__") || customItems.length > 0;
  }
  return Boolean(answer);
}

function buildPromptText() {
  const selectedTerms = getAnswerWithCustom({ id: "candidate_terms", type: "multi" }) || [];
  const constraints = (getAnswerWithCustom({ id: "constraints", type: "multi" }) || []).join("；") || "无额外约束";
  const workflow = getWorkflowDefinition();
  const mergePolicy = getAnswerWithCustom({ id: "merge_policy", type: "single" }) || "未指定";
  const synonymsConfirmed =
    getAnswerWithCustom({ id: "bilingual_synonym", type: "boolean" }) === "yes"
      ? getSynonymEvidenceSummary()
      : "不强制做同义词归并";
  const refinementBlock = state.refinements.length
    ? `\n\n继续追问修改：\n${state.refinements.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
    : "";

  if (state.workflow === "synonym_merge") {
    return `你是材料术语标准化与同义词合并助手，请根据以下要求生成可审计的同义词合并结果。

原始需求参考：
${state.prompt || "待输入"}

流程类型：
${workflow.label}

合并目标：
${getAnswerWithCustom({ id: "target_type", type: "single" }) || "待确认"}

待判断术语：
${selectedTerms.length ? selectedTerms.join("、") : "待用户补充"}

同义词确认结果：
${synonymsConfirmed}

合并策略：
${mergePolicy}

输出格式：
${getAnswerWithCustom({ id: "output_format", type: "single" }) || "待确认"}

审计约束：
${constraints}

补充说明：
${state.answers.extra_instructions || "无"}

知识证据：
${state.mode === "rag" ? state.knowledge || "未提供详细知识片段。" : "基于通用领域模板组织候选。"}

执行规则：
1. 只有存在明确证据的同义词、别名、英文缩写、符号表达、又称、见/参见关系才能自动合并。
2. 相近但不完全等价的概念必须标记为待复核或同类相关，不能直接并入标准名。
3. 每个合并组至少输出：标准名、别名列表、关系类型、证据来源、证据原文、置信度、是否需要人工复核。
4. 明确列出“不应合并”的边界和原因。
5. 按“${getAnswerWithCustom({ id: "output_format", type: "single" }) || "待确认"}”输出。${refinementBlock}`;
  }

  return `你是${getAnswerWithCustom({ id: "business_role", type: "single" }) || "专业信息抽取助手"}，请根据以下要求从用户提供的文档中执行信息抽取。

原始需求参考：
${state.prompt || "待输入"}

流程类型：
${workflow.label}

任务场景：
${state.scenario ? state.scenario.label : "待识别"}

抽取目标：
${getAnswerWithCustom({ id: "target_type", type: "single" }) || "待确认"}

重点候选词条：
${selectedTerms.length ? selectedTerms.join("、") : "待用户补充"}

输出格式要求：
${getAnswerWithCustom({ id: "output_format", type: "single" }) || "待确认"}

术语标准化要求：
${getAnswerWithCustom({ id: "bilingual_synonym", type: "boolean" }) === "yes" ? "需要英文附中文翻译，并合并同义词。" : "无需强制中英对照。"}
术语合并策略：
${mergePolicy}

同义词确认结果：
${synonymsConfirmed}

输出与质量约束：
${constraints}

补充说明：
${state.answers.extra_instructions || "无"}

候选项来源：
${state.mode === "rag" ? `优先参考附带术语片段：${state.knowledge || "未提供详细术语片段。"}` : "基于通用领域模板组织问答与候选词。"}

执行规则：
1. 仅基于待处理文档内容抽取，不要臆造文中没有的信息。
2. 先识别同义词、近义词、英文缩写和等价表达，再归并到标准词条。
3. 若出现英文术语，必须在同一字段中附带中文翻译。
4. 每条结果尽量保留原文证据句；无法判断时按约束输出空值或 null。
5. 按“${getAnswerWithCustom({ id: "output_format", type: "single" }) || "待确认"}”输出，字段至少包含：标准词条、原文表述、同义/英文表达、证据句、备注。
6. 输出前检查去重、字段完整性和格式合法性。${refinementBlock}`;
}

function buildPromptMarkdown() {
  return `# 规范提示词草稿

## 原始需求
${state.prompt || "待输入"}

## 任务配置
- 输出目标：${getWorkflowDefinition().label}
- 业务角色：${getAnswerWithCustom({ id: "business_role", type: "single" }) || "待确认"}
- 任务场景：${state.scenario ? state.scenario.label : "待识别"}
- 抽取目标：${getAnswerWithCustom({ id: "target_type", type: "single" }) || "待确认"}
- 候选词条：${(getAnswerWithCustom({ id: "candidate_terms", type: "multi" }) || []).join("、") || "待用户补充"}
- 输出格式：${getAnswerWithCustom({ id: "output_format", type: "single" }) || "待确认"}

## 术语标准化
- 中英对照：${getAnswerWithCustom({ id: "bilingual_synonym", type: "boolean" }) === "yes" ? "需要" : "不强制"}
- 同义词确认：${getSynonymEvidenceSummary()}

## 抽取约束
${(getAnswerWithCustom({ id: "constraints", type: "multi" }) || []).map((item) => `- ${item}`).join("\n") || "- 无额外约束"}

## 补充说明
${state.answers.extra_instructions || "无"}

## 继续追问修改
${state.refinements.map((item, index) => `${index + 1}. ${item}`).join("\n") || "暂无"}
`;
}

function buildPromptJson() {
  return JSON.stringify(
    {
      raw_prompt: state.prompt || "",
      model: state.model,
      workflow: state.workflow,
      workflow_label: getWorkflowDefinition().label,
      scenario: state.scenario ? state.scenario.label : "",
      source_mode: state.mode,
      question_source: {
        type: state.questionSource,
        detail: state.questionSourceDetail,
      },
      prompt_source: {
        type: state.promptSource,
        detail: state.promptSourceDetail,
      },
      answers: state.answers,
      custom_answers: state.customAnswers,
      refinements: state.refinements,
      prompt_draft: buildPromptText(),
    },
    null,
    2
  );
}

function renderPreview() {
  if (!state.prompt) {
    elements.previewOutput.textContent = "系统将在这里实时预览规范提示词草稿。";
    return;
  }

  const previewMap = {
    text: buildPromptText(),
    markdown: buildPromptMarkdown(),
    json: buildPromptJson(),
  };

  if (state.finalPrompt) {
    previewMap.text = state.finalPrompt;
    previewMap.markdown = buildPromptMarkdown();
    previewMap.json = buildPromptJson();
  }

  elements.previewOutput.textContent = previewMap[state.previewFormat];
}

function updateSummaryCards() {
  const cards = [
    {
      label: "输出目标",
      value: getWorkflowDefinition().label,
    },
    {
      label: "问答来源",
      value: getGenerationSourceText("question"),
    },
    {
      label: "提示词来源",
      value: getGenerationSourceText("prompt"),
    },
    {
      label: "知识来源",
      value:
        state.mode === "rag"
          ? getSelectedKnowledgeSources()
              .map((source) => source.label)
              .join("、") || "未选择知识库"
          : "通用模板",
    },
    {
      label: "场景识别",
      value: state.scenario ? state.scenario.label : "未识别",
    },
    {
      label: "已选词条",
      value: (getAnswerWithCustom({ id: "candidate_terms", type: "multi" }) || []).join("、") || "尚未选择",
    },
    {
      label: "输出格式",
      value: getAnswerWithCustom({ id: "output_format", type: "single" }) || "尚未确认",
    },
  ];

  elements.summaryCards.innerHTML = cards
    .map(
      (card) => `
        <div class="summary-card">
          <span>${escapeHtml(card.label)}</span>
          <strong>${escapeHtml(card.value)}</strong>
        </div>
      `
    )
    .join("");
}

function updateTopStatus() {
  const sourceLabel = state.mode === "rag" ? state.knowledgeProfile?.sourceLabel || "RAG 知识库" : "通用模板";
  const selectedSources = getSelectedKnowledgeSources();
  const selectedSourceText = selectedSources.length ? selectedSources.map((source) => source.label).join("、") : "未选择知识库";
  const readyCount = state.knowledgeSources.filter((source) => source.health === "ready").length;
  const statusSuffix = state.knowledgeInspectError ? `；检查提示：${state.knowledgeInspectError}` : "";
  elements.modeLabel.textContent = sourceLabel;
  elements.sourceBadge.textContent = sourceLabel;
  elements.scenarioBadge.textContent = state.scenario ? state.scenario.label : "等待识别场景";
  if (state.mode === "rag") {
    elements.knowledgeStatusTitle.textContent = state.retrievedKnowledge.length
      ? "当前使用 RAG 知识库"
      : "等待检索 RAG 知识库";
    elements.knowledgeStatusText.textContent = state.retrievedKnowledge.length
      ? `已从 ${selectedSourceText} 召回 ${state.retrievedKnowledge.length} 条知识片段。`
      : state.knowledgeAvailable
      ? `可用知识库 ${readyCount}/${state.knowledgeSources.length}；生成问答时会从已选知识库召回片段：${selectedSourceText}${statusSuffix}。`
        : "尚未检测到可用知识源。";
  } else {
    elements.knowledgeStatusTitle.textContent = state.knowledgeAvailable ? "RAG 知识库已接入" : "当前使用通用模板";
    elements.knowledgeStatusText.textContent = state.knowledgeAvailable
      ? `当前任务使用通用模板；可用知识库 ${readyCount}/${state.knowledgeSources.length}${statusSuffix}。`
      : state.knowledgeStatusDetail && state.knowledgeStatusDetail !== "尚未检测"
        ? state.knowledgeStatusDetail
        : "未接入知识库时，系统会基于通用领域模板生成候选项。";
  }
}

async function checkLLMHealth(force = false) {
  if (!isServerBackedPage()) {
    setLLMStatus("未连接本机后端", "请通过 http://127.0.0.1:8080/ 打开；真实调用需要先运行 npm start。", false);
    return;
  }

  const now = Date.now();
  if (!force && (state.llmBusy || now - state.lastHealthCheckAt < 1200)) {
    return;
  }
  state.lastHealthCheckAt = now;

  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("health check failed");
    }
    const payload = await response.json();
    if (payload.baseUrl) elements.llmBaseUrlInput.value = payload.baseUrl;
    if (!payload.llmConfigured) {
      setLLMStatus("后端已启动，LLM 未配置", "可在这里填写 OpenAI-compatible API 设置，无需重启。", false);
      if (payload.model) {
        ensureModelOption(payload.model);
      }
      return;
    }

    ensureModelOption(payload.model);
    let endpointLabel = payload.baseUrl || "";
    try {
      endpointLabel = new URL(payload.baseUrl).host;
    } catch (_error) {
      endpointLabel = payload.baseUrl || "";
    }
    setLLMStatus("LLM 已连接", `${payload.model} · ${endpointLabel}`, true);
  } catch (error) {
    setLLMStatus("未启动本机后端", "请在项目目录运行 npm start；后端入口是 python3 server.py。", false);
  }
}

async function generateQuestionnaire() {
  state.prompt = elements.promptInput.value.trim();
  state.knowledge = elements.knowledgeInput.value.trim();
  state.model = elements.modelSelect.value;

  if (!state.prompt) {
    window.alert("请先输入原始提示词。");
    return;
  }

  setLLMBusy(true, "后端处理中");
  elements.stageLabel.textContent = "后端正在创建问答会话";
  elements.stageDesc.textContent = "后端会管理问题顺序、答案和自定义补充；本路径不调用 LLM。";
  try {
    state.scenario = inferScenario(state.prompt);
    await hydrateKnowledgeFromMilvus();
    const session = await createBackendSession("local");
    state.history.unshift({
      title: state.prompt.length > 20 ? `${state.prompt.slice(0, 20)}...` : state.prompt,
      subtitle: `后端编排 / ${session.scenario.label} / ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
    });
    renderHistory();
    elements.stageLabel.textContent = "后端已创建问答会话";
    elements.stageDesc.textContent = `当前问题流由后端 Orchestrator 管理，候选项来自本地模板，未调用 LLM；会话 ID：${session.id}`;
  } catch (error) {
    window.alert(`后端编排不可用，已回退浏览器本地模板。\n${error.message}`);
    generateQuestionnaireLocal();
  } finally {
    setLLMBusy(false);
  }
}

async function generateQuestionnaireWithLLM() {
  state.prompt = elements.promptInput.value.trim();
  state.knowledge = elements.knowledgeInput.value.trim();
  state.model = elements.modelSelect.value;

  if (!state.prompt) {
    window.alert("请先输入原始提示词。");
    return;
  }
  if (!state.llmConfigured) {
    window.alert("LLM 后端未启用。请通过 server.js 启动并配置 LLM_API_KEY。");
    return;
  }

  setLLMBusy(true, "LLM 调用中");
  elements.stageLabel.textContent = "后端正在调用 LLM 生成问题流";
  elements.stageDesc.textContent = "后端会保存 LLM 生成的问题，并推进后续答案。";

  try {
    state.scenario = inferScenario(state.prompt);
    await hydrateKnowledgeFromMilvus();
    const session = await createBackendSession("llm");
    state.history.unshift({
      title: state.prompt.length > 20 ? `${state.prompt.slice(0, 20)}...` : state.prompt,
      subtitle: `后端 LLM / ${session.scenario.label} / ${new Date().toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      })}`,
    });
    renderHistory();
    elements.stageLabel.textContent = `LLM 已生成问答流程：${state.model}`;
    elements.stageDesc.textContent = `当前问题流来自后端 Orchestrator 的真实 LLM 调用；会话 ID：${session.id}`;
  } catch (error) {
    window.alert(`后端 LLM 生成失败，已保留本地模板入口。\n${error.message}`);
    elements.stageLabel.textContent = "LLM 生成失败";
    elements.stageDesc.textContent = "可以继续使用后端规则生成问题流，或检查后端环境变量与模型服务。";
  } finally {
    setLLMBusy(false);
  }
}

async function regenerateFinalPrompt() {
  if (state.orchestratorEnabled && state.orchestratorSessionId) {
    try {
      const session = await apiJson(`/api/orchestrator/sessions/${state.orchestratorSessionId}/finalize`, {
        method: "POST",
        body: { promptMode: "local" },
      });
      syncFromOrchestratorSession(session);
      await loadPromptVersions(session.id);
      await loadPersistedSessions();
      await loadAuditLogs();
      elements.stageLabel.textContent = "后端已归纳提示词，可继续追问修改";
      elements.stageDesc.textContent = "最终提示词由后端 Orchestrator 规则生成，未调用 LLM。";
      elements.previewStageLabel.textContent = "后端已生成";
      return;
    } catch (error) {
      window.alert(`后端归纳失败，已回退浏览器本地归纳。\n${error.message}`);
    }
  }

  state.promptSource = "本地模板";
  state.promptSourceDetail = "规则归纳";
  state.finalPrompt = buildPromptText();
  renderPreview();
  updateSummaryCards();
  elements.stageLabel.textContent = "提示词已归纳，可继续追问修改";
  elements.stageDesc.textContent = "你可以继续补充要求，系统会在当前草稿上迭代修改。";
  elements.previewStageLabel.textContent = "提示词已生成";
}

async function regenerateFinalPromptWithLLM() {
  if (!state.prompt || !state.questions.length) {
    window.alert("请先生成并完成问答流程。");
    return;
  }
  if (!state.llmConfigured) {
    window.alert("LLM 后端未启用。请通过 server.js 启动并配置 LLM_API_KEY。");
    return;
  }

  collectCurrentAnswer();
  setLLMBusy(true, "LLM 调用中");
  elements.stageLabel.textContent = "LLM 正在归纳最终提示词";
  elements.stageDesc.textContent = "模型会基于已确认答案生成更自然、完整的可执行抽取提示词。";

  try {
    if (state.orchestratorEnabled && state.orchestratorSessionId) {
      const session = await apiJson(`/api/orchestrator/sessions/${state.orchestratorSessionId}/finalize`, {
        method: "POST",
        body: { promptMode: "llm", model: state.model },
      });
      syncFromOrchestratorSession(session);
      await loadPromptVersions(session.id);
      await loadPersistedSessions();
      await loadAuditLogs();
      elements.stageLabel.textContent = "后端 LLM 已归纳提示词，可继续追问修改";
      elements.stageDesc.textContent = "最终提示词由后端 Orchestrator 调用 LLM 生成。";
      elements.previewStageLabel.textContent = "后端 LLM 已生成";
      return;
    }

    const content = await callLLM(
      [
        {
          role: "system",
          content:
            "你是严谨的信息抽取提示词工程师。请直接输出最终可执行提示词，不要解释过程，不要输出 Markdown 标题以外的寒暄。",
        },
        {
          role: "user",
      content: JSON.stringify(
            {
              raw_prompt: state.prompt,
              workflow: state.workflow,
              workflow_label: getWorkflowDefinition().label,
              source_mode: state.mode,
              knowledge: state.knowledge,
              scenario: state.scenario,
              model_answers: state.answers,
              refinements: state.refinements,
              local_prompt_draft: buildPromptText(),
              requirements: [
                "最终提示词必须能直接交给抽取模型执行。",
                "保留用户确认的候选词条、同义词、输出格式和质量约束。",
                "英文术语必须附带中文翻译。",
                "强调不要臆造，尽量保留原文证据句。",
              ],
            },
            null,
            2
          ),
        },
      ],
      { temperature: 0.2 }
    );

    state.finalPrompt = content.trim() || buildPromptText();
    state.promptSource = "LLM 归纳";
    state.promptSourceDetail = state.model;
    renderPreview();
    updateSummaryCards();
    elements.stageLabel.textContent = "LLM 已归纳提示词，可继续追问修改";
    elements.stageDesc.textContent = "你可以继续补充要求，系统会在当前草稿上迭代修改。";
    elements.previewStageLabel.textContent = "LLM 已生成";
  } catch (error) {
    window.alert(`LLM 归纳失败，已保留本地提示词。\n${error.message}`);
    regenerateFinalPrompt();
  } finally {
    setLLMBusy(false);
  }
}

async function submitCurrentAnswerToBackend() {
  const question = getCurrentQuestion();
  if (!question || !state.orchestratorSessionId) {
    return null;
  }
  return apiJson(`/api/orchestrator/sessions/${state.orchestratorSessionId}/answers`, {
    method: "POST",
    body: {
      questionId: question.id,
      answer: state.answers[question.id],
      customAnswer: state.customAnswers[question.id] || "",
    },
  });
}

async function moveToNextQuestion() {
  collectCurrentAnswer();
  updateSummaryCards();
  renderPreview();

  if (!validateCurrentQuestion()) {
    window.alert("当前问题是必填项，请先完成选择。");
    return;
  }

  if (state.orchestratorEnabled && state.orchestratorSessionId) {
    const shouldFinalize = state.currentIndex >= state.questions.length - 1;
    try {
      setLLMBusy(true, "后端提交中");
      const session = await submitCurrentAnswerToBackend();
      syncFromOrchestratorSession(session);
      if (shouldFinalize) {
        await regenerateFinalPrompt();
      }
    } catch (error) {
      window.alert(`后端提交答案失败。\n${error.message}`);
    } finally {
      setLLMBusy(false);
    }
    return;
  }

  if (state.currentIndex >= state.questions.length - 1) {
    regenerateFinalPrompt();
    renderStepList();
    return;
  }

  moveToNextVisibleQuestion();
  renderQuestion();
  renderPreview();
}

async function moveToPreviousQuestion() {
  collectCurrentAnswer();
  updateSummaryCards();
  renderPreview();

  if (state.currentIndex === 0) {
    return;
  }

  if (state.orchestratorEnabled && state.orchestratorSessionId) {
    try {
      const session = await apiJson(`/api/orchestrator/sessions/${state.orchestratorSessionId}/navigate`, {
        method: "POST",
        body: { direction: "previous" },
      });
      syncFromOrchestratorSession(session);
    } catch (error) {
      window.alert(`后端回退失败。\n${error.message}`);
    }
    return;
  }

  moveToPreviousVisibleQuestion();
  renderQuestion();
}

async function skipCurrentQuestion() {
  const question = getCurrentQuestion();
  if (!question) {
    return;
  }
  if (question.required) {
    window.alert("当前问题是必填项，请先完成选择。");
    return;
  }

  if (question.type === "multi") {
    state.answers[question.id] = [];
  } else {
    state.answers[question.id] = "";
  }
  state.customAnswers[question.id] = "";

  if (state.orchestratorEnabled && state.orchestratorSessionId) {
    try {
      setLLMBusy(true, "后端提交中");
      const session = await submitCurrentAnswerToBackend();
      syncFromOrchestratorSession(session);
      if (state.currentIndex >= state.questions.length - 1) {
        await regenerateFinalPrompt();
      }
    } catch (error) {
      window.alert(`后端跳过失败。\n${error.message}`);
    } finally {
      setLLMBusy(false);
    }
    return;
  }

  if (state.currentIndex >= state.questions.length - 1) {
    regenerateFinalPrompt();
    return;
  }

  moveToNextVisibleQuestion();
  updateSummaryCards();
  renderQuestion();
  renderPreview();
}

async function applyRefinement() {
  const refinement = elements.refineInput.value.trim();
  if (!refinement) {
    window.alert("请输入修改意见。");
    return;
  }
  if (!state.prompt) {
    window.alert("请先生成问答流程。");
    return;
  }

  collectCurrentAnswer();

  if (state.orchestratorEnabled && state.orchestratorSessionId) {
    try {
      setLLMBusy(true, "后端处理中");
      const session = await apiJson(`/api/orchestrator/sessions/${state.orchestratorSessionId}/finalize`, {
        method: "POST",
        body: { promptMode: "local", refinement },
      });
      syncFromOrchestratorSession(session);
      await loadPromptVersions(session.id);
      await loadPersistedSessions();
      await loadAuditLogs();
      elements.refineInput.value = "";
      elements.stageLabel.textContent = "后端已应用修改意见";
      elements.stageDesc.textContent = "修改意见已记录在后端会话，并使用后端规则重新归纳提示词，未调用 LLM。";
    } catch (error) {
      window.alert(`后端应用修改失败。\n${error.message}`);
    } finally {
      setLLMBusy(false);
    }
    return;
  }

  state.refinements.push(refinement);
  state.promptSource = "本地模板";
  state.promptSourceDetail = "继续追问修改";
  state.finalPrompt = buildPromptText();
  renderPreview();
  updateSummaryCards();
  elements.refineInput.value = "";
}

function downloadPrompt() {
  if (!state.prompt) {
    window.alert("请先输入并生成问答流程。");
    return;
  }

  const contentMap = {
    text: state.finalPrompt || buildPromptText(),
    markdown: buildPromptMarkdown(),
    json: buildPromptJson(),
  };
  const extensionMap = {
    text: "txt",
    markdown: "md",
    json: "json",
  };
  const content = contentMap[state.previewFormat] || contentMap.text;
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `normalized-prompt.${extensionMap[state.previewFormat] || "txt"}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function resetApp() {
  state.workflow = "prompt_generation";
  state.prompt = "";
  state.knowledge = "";
  state.knowledgeProfile = null;
  state.retrievedKnowledge = [];
  state.manualKnowledge = "";
  state.scenario = null;
  state.questions = [];
  state.answers = {};
  state.customAnswers = {};
  state.orchestratorSessionId = "";
  state.orchestratorEnabled = false;
  state.currentIndex = 0;
  state.finalPrompt = "";
  state.refinements = [];
  state.previewFormat = "text";
  state.promptVersions = [];
  state.questionSource = "本地模板";
  state.questionSourceDetail = "尚未生成";
  state.promptSource = "本地模板";
  state.promptSourceDetail = "实时预览";

  elements.promptInput.value = "";
  elements.knowledgeInput.value = "";
  elements.refineInput.value = "";
  elements.previewOutput.textContent = "系统将在这里实时预览规范提示词草稿。";
  elements.emptyState.classList.remove("hidden");
  elements.questionnaire.classList.add("hidden");
  elements.progressPill.textContent = "1 / 1";
  elements.questionStepLabel.textContent = "步骤 1";
  elements.questionMeta.innerHTML = "";
  elements.questionCard.innerHTML = "";
  elements.previewStageLabel.textContent = "等待生成";
  elements.stageLabel.textContent = "第一步：等待生成问答";
  elements.stageDesc.textContent = "系统会先识别任务类型与领域，再进入逐步确认流程。";

  [...elements.previewFormatSwitch.querySelectorAll(".format-btn")].forEach((item) =>
    item.classList.toggle("active", item.dataset.format === "text")
  );

  updateSummaryCards();
  updateTopStatus();
  renderStepList();
  renderPreview();
  renderHistory();
  renderPromptVersions();
  setLLMBusy(false);
}

elements.modeSwitch.addEventListener("click", (event) => {
  const button = event.target.closest(".mode-btn");
  if (!button) {
    return;
  }

  state.mode = button.dataset.mode;
  state.knowledge = elements.knowledgeInput.value.trim();
  state.retrievedKnowledge = [];
  state.manualKnowledge = state.knowledge;
  state.knowledgeProfile =
    state.mode === "rag" && state.scenario ? parseKnowledgeProfile(state.knowledge, state.scenario) : null;
  [...elements.modeSwitch.querySelectorAll(".mode-btn")].forEach((item) =>
    item.classList.toggle("active", item === button)
  );
  elements.knowledgeField.classList.toggle("hidden", state.mode !== "rag");
  updateTopStatus();
  updateSummaryCards();
  renderPreview();
});

elements.knowledgeSourceList.addEventListener("change", () => {
  state.selectedKnowledgeSourceIds = [...elements.knowledgeSourceList.querySelectorAll('input[name="knowledgeSource"]:checked')].map(
    (item) => item.value
  );
  state.retrievedKnowledge = [];
  updateTopStatus();
  updateSummaryCards();
  renderPreview();
});

elements.uploadKnowledgeBtn.addEventListener("click", () => {
  uploadKnowledgeFiles();
});

elements.knowledgeFileInput.addEventListener("change", updateSelectedFileName);

elements.uploadedDocumentList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete-upload]");
  if (!button) return;
  deleteUploadedDocument(button.dataset.deleteUpload).catch((error) => {
    window.alert(`删除上传文档失败。\n${error.message}`);
  });
});

elements.historyList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-load-session]");
  if (!button) return;
  restoreSession(button.dataset.loadSession).catch((error) => {
    window.alert(`恢复会话失败。\n${error.message}`);
  });
});

elements.previewFormatSwitch.addEventListener("click", (event) => {
  const button = event.target.closest(".format-btn");
  if (!button) {
    return;
  }
  state.previewFormat = button.dataset.format;
  [...elements.previewFormatSwitch.querySelectorAll(".format-btn")].forEach((item) =>
    item.classList.toggle("active", item === button)
  );
  renderPreview();
});

elements.modelSelect.addEventListener("change", () => {
  state.model = elements.modelSelect.value;
  renderPreview();
});

elements.saveLlmConfigBtn.addEventListener("click", () => {
  saveLLMConfig();
});

elements.questionCard.addEventListener("input", () => {
  collectCurrentAnswer();
  updateSummaryCards();
  renderPreview();
});

elements.questionCard.addEventListener("change", () => {
  collectCurrentAnswer();
  updateSummaryCards();
  renderPreview();
});

elements.generateBtn.addEventListener("click", generateQuestionnaire);
elements.llmGenerateBtn.addEventListener("click", generateQuestionnaireWithLLM);
elements.prevBtn.addEventListener("click", moveToPreviousQuestion);
elements.nextBtn.addEventListener("click", moveToNextQuestion);
elements.confirmBtn.addEventListener("click", moveToNextQuestion);
elements.skipBtn.addEventListener("click", skipCurrentQuestion);
elements.refineBtn.addEventListener("click", applyRefinement);
elements.llmPromptBtn.addEventListener("click", regenerateFinalPromptWithLLM);
elements.downloadBtn.addEventListener("click", downloadPrompt);
elements.resetBtn.addEventListener("click", resetApp);

elements.todayLabel.textContent = new Date().toLocaleDateString("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

loadSynonymExamples();
resetApp();
loadLLMConfig().finally(() => checkLLMHealth(true));
refreshKnowledgeStatus();
loadUploadedDocuments();
loadPersistedSessions();
loadAuditLogs();
window.addEventListener("focus", checkLLMHealth);
window.addEventListener("pageshow", checkLLMHealth);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    checkLLMHealth();
  }
});
window.setInterval(() => {
  if (!state.llmConfigured) {
    checkLLMHealth();
  }
}, 5000);
