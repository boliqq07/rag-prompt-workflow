#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_INPUT_DIR = "/Users/cyc/Desktop/立讯/知识库文档";
const DEFAULT_OUTPUT = path.join(process.cwd(), "data", "guideline-seed-vocab.json");
const DEFAULT_REPORT = path.join(process.cwd(), "data", "guideline-seed-vocab.md");

const FACET_TYPES = [
  "PhysicalComponent",
  "FailureMode",
  "EngineeringFeature",
  "DesignControl",
  "ParameterLimit",
  "BoundaryCondition",
  "TestCondition",
];

const STOP_TERMS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "shall",
  "should",
  "must",
  "设计",
  "要求",
  "规范",
  "文件",
  "版本",
  "日期",
  "目录",
  "页码",
  "table of contents",
  "contents",
  "purpose",
  "scope",
  "revision",
  "design guideline",
  "the purpose of this guide line",
]);

const ENGLISH_STARTER_RE = /^(the|this|that|these|those|if|when|where|because|another|best|for|unless|in order|refer to|like the|just like|it is|there is|there are)\b/i;
const DOMAIN_KEYWORD_RE =
  /密封|连接器|壳体|端子|插头|插座|护套|卡扣|锁|限位|导向|防呆|编码|倒刺|凸台|筋|槽|孔|PIN|针|保持力|插入力|拔出力|过盈|间隙|公差|开裂|泄漏|位移|失效|connector|seal|o-ring|housing|terminal|pin|tab|plug|socket|lock|retainer|clip|coding|keying|barb|mating|unmating|force|tolerance|clearance|interference|leak|crack|failure|retention/i;

const FACET_RULES = [
  {
    type: "FailureMode",
    patterns: [
      /失效|失效模式|泄漏|漏气|漏水|位移|脱位|后退|脱落|松动|开裂|断裂|破裂|裂纹|变形|磨损|疲劳|腐蚀|短路|烧蚀|干涉|卡滞|破损|损坏|failure|leak|crack|fracture|wear|fatigue|corrosion|damage|deformation|displacement|loose|short/i,
    ],
  },
  {
    type: "ParameterLimit",
    patterns: [
      /\d+(\.\d+)?\s*(mm|cm|m|n|kn|mpa|pa|℃|°c|v|kv|a|ma|Ω|ohm|%|次|cycle|cycles|n\.m)/i,
      /公差|间隙|过盈|尺寸|厚度|宽度|高度|长度|半径|直径|角度|力值|保持力|插入力|拔出力|扭矩|limit|tolerance|clearance|interference|thickness|width|height|length|diameter|force|torque/i,
    ],
  },
  {
    type: "TestCondition",
    patterns: [
      /测试|试验|验证|量产|插拔|振动|温升|老化|疲劳测试|耐久|循环|实验|test|validation|verify|mating|unmating|vibration|aging|cycle|durability/i,
    ],
  },
  {
    type: "BoundaryCondition",
    patterns: [
      /温度|湿度|环境|防水|防尘|盐雾|压力|载荷|工况|边界|密封等级|IP\d+|temperature|humidity|environment|waterproof|dustproof|salt spray|pressure|load|condition/i,
    ],
  },
  {
    type: "PhysicalComponent",
    patterns: [
      /密封圈|密封件|密封垫|壳体|接口|端子|PIN|针|插头|插座|连接器|护套|卡扣|锁扣|锁止|限位|CPA|TPA|胶芯|屏蔽|弹片|倒刺|凸台|筋|槽|孔|connector|seal|gasket|housing|terminal|pin|tab|plug|socket|lock|retainer|clip|shield|rib|slot|hole|barb/i,
    ],
  },
  {
    type: "EngineeringFeature",
    patterns: [
      /结构|特征|倒刺|限位|导向|防呆|编码|定位|支撑|加强|圆角|倒角|筋位|卡槽|配合|干涉量|过盈量|feature|structure|barb|limit|guide|coding|keying|position|support|chamfer|radius|fit/i,
    ],
  },
  {
    type: "DesignControl",
    patterns: [
      /应|需|必须|避免|防止|保证|控制|设置|采用|检查|确认|满足|shall|should|must|avoid|prevent|ensure|control|set|apply|check|meet/i,
    ],
  },
];

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT_DIR,
    output: DEFAULT_OUTPUT,
    report: DEFAULT_REPORT,
    minCount: 2,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === "--input" && next) {
      args.input = next;
      index += 1;
    } else if (current === "--output" && next) {
      args.output = next;
      index += 1;
    } else if (current === "--report" && next) {
      args.report = next;
      index += 1;
    } else if (current === "--min-count" && next) {
      args.minCount = Number(next) || args.minCount;
      index += 1;
    }
  }

  return args;
}

function walkFiles(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    if (entry.name.startsWith(".")) return [];
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) return walkFiles(fullPath);
    if (/\.(docx?|pdf)$/i.test(entry.name)) return [fullPath];
    return [];
  });
}

function convertDocumentToText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guideline-vocab-"));
  const outputPath = path.join(tmpDir, `${path.basename(filePath)}.txt`);

  try {
    if (ext === ".pdf") {
      execFileSync("/opt/homebrew/bin/pdftotext", ["-layout", filePath, outputPath], { stdio: "ignore" });
    } else {
      execFileSync("/usr/bin/textutil", ["-convert", "txt", "-output", outputPath, filePath], { stdio: "ignore" });
    }
    return fs.readFileSync(outputPath, "utf8");
  } catch (error) {
    return "";
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function normalizeLine(line) {
  return String(line || "")
    .replace(/\u0000/g, "")
    .replace(/[.…·]{3,}.*/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-*•●○◆◇■□▪▫·]+/, "")
    .trim();
}

function isHeadingLike(line) {
  if (!line || line.length > 80) return false;
  if (/table of contents|目录|purpose|scope|revision history/i.test(line)) return false;
  if (/^(第?\d+(\.\d+)*[章节条款]?|[A-Z]\d+(\.\d+)*)\s*[\u4e00-\u9fa5A-Za-z]/.test(line)) return true;
  if (/^[A-Z][A-Za-z0-9&/\-\s]{4,60}$/.test(line)) return true;
  return false;
}

function looksLikeUsefulTerm(term) {
  const value = normalizeLine(term);
  if (!value || value.length < 2 || value.length > 64) return false;
  if (STOP_TERMS.has(value.toLowerCase())) return false;
  if (/^\d+(\.\d+)?$/.test(value)) return false;
  if (/^[.,;:()[\]\-_/]+$/.test(value)) return false;
  if (/[.…·]{3,}/.test(value)) return false;
  if (/^[A-Za-z\s]+$/.test(value)) {
    const words = value.split(/\s+/).filter(Boolean);
    if (ENGLISH_STARTER_RE.test(value)) return false;
    if (words.length > 5) return false;
    if (!DOMAIN_KEYWORD_RE.test(value)) return false;
  }
  if (/[\u4e00-\u9fa5]/.test(value) && !DOMAIN_KEYWORD_RE.test(value)) return false;
  return true;
}

function splitSentences(text) {
  return String(text || "")
    .split(/[。；;.!?\n\r]+/)
    .map(normalizeLine)
    .filter((item) => item.length >= 4);
}

function extractBilingualPairs(line) {
  const pairs = [];
  const regexes = [
    /([A-Za-z][A-Za-z0-9&/\-\s]{1,50})[（(]([\u4e00-\u9fa5][^）)]{1,30})[）)]/g,
    /([\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9&/\-\s]{1,30})[（(]([A-Za-z][A-Za-z0-9&/\-\s]{1,50})[）)]/g,
  ];

  regexes.forEach((regex) => {
    let match = regex.exec(line);
    while (match) {
      pairs.push([match[1].trim(), match[2].trim()]);
      match = regex.exec(line);
    }
  });

  return pairs;
}

function extractCandidatePhrases(line) {
  const phrases = new Set();
  const clean = normalizeLine(line);
  if (!clean) return [];

  extractBilingualPairs(clean).forEach(([a, b]) => {
    phrases.add(a);
    phrases.add(b);
  });

  const cjkMatches = clean.match(/[\u4e00-\u9fa5A-Za-z0-9&/\-]{2,24}(系统|组件|部件|结构|机构|接口|端子|密封圈|密封件|壳体|护套|卡扣|锁扣|倒刺|凸台|筋|槽|孔|失效|位移|开裂|泄漏|保持力|插入力|拔出力|过盈量|间隙|公差|测试|试验|验证|设计|防呆|编码)/g) || [];
  cjkMatches.forEach((item) => phrases.add(item));

  const englishMatches = clean.match(/\b[A-Z][A-Za-z0-9&/\-]*(?:\s+[A-Za-z0-9&/\-]+){1,5}\b/g) || [];
  englishMatches.forEach((item) => phrases.add(item));

  if (isHeadingLike(clean)) {
    phrases.add(clean.replace(/^(第?\d+(\.\d+)*[章节条款]?|[A-Z]\d+(\.\d+)*)\s*/, "").trim());
  }

  return [...phrases]
    .map((item) => item.replace(/[：:，,。.;；()[\]【】]+$/g, "").trim())
    .filter(looksLikeUsefulTerm);
}

function classifyFacet(term, context) {
  const text = `${term} ${context || ""}`;
  const scores = Object.fromEntries(FACET_TYPES.map((type) => [type, 0]));

  FACET_RULES.forEach((rule) => {
    rule.patterns.forEach((pattern) => {
      if (pattern.test(text)) scores[rule.type] += 1;
    });
  });

  const sorted = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1]);

  if (!sorted.length) return "Unclassified";
  return sorted[0][0];
}

function slugify(text) {
  const hash = crypto.createHash("sha1").update(text).digest("hex").slice(0, 8);
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return ascii ? `${ascii}_${hash}` : `term_${hash}`;
}

function addCandidate(map, { term, alias, facetType, sourceFile, line, method }) {
  const canonicalName = term.trim();
  if (!canonicalName || STOP_TERMS.has(canonicalName.toLowerCase())) return;

  const key = `${facetType}:${canonicalName.toLowerCase()}`;
  if (!map.has(key)) {
    map.set(key, {
      vocab_id: `${facetType.toLowerCase()}.${slugify(canonicalName)}`,
      canonical_name: canonicalName,
      facet_type: facetType,
      aliases: [],
      status: "guideline_seed_candidate",
      confidence_bucket: "candidate",
      created_by: "guideline_rule_extraction",
      sources: [],
      document_paths: [],
      counts: {
        mentions: 0,
        documents: 0,
      },
      extraction_methods: [],
    });
  }

  const item = map.get(key);
  if (alias && alias !== canonicalName && !item.aliases.includes(alias)) item.aliases.push(alias);
  item.counts.mentions += 1;
  if (!item.extraction_methods.includes(method)) item.extraction_methods.push(method);

  const docName = path.basename(sourceFile);
  if (!item.document_paths.includes(sourceFile)) {
    item.document_paths.push(sourceFile);
    item.counts.documents = item.document_paths.length;
  }
  if (item.sources.length < 5) {
    item.sources.push({
      document: docName,
      path: sourceFile,
      evidence_text: line.slice(0, 300),
      method,
    });
  }
}

function extractFromDocument(filePath, text, candidateMap) {
  const lines = text.split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const sentences = splitSentences(text);
  const strongLines = lines.filter((line) => isHeadingLike(line) || extractBilingualPairs(line).length);

  strongLines.forEach((line) => {
    extractBilingualPairs(line).forEach(([a, b]) => {
      const primary = /[\u4e00-\u9fa5]/.test(b) ? b : a;
      const alias = primary === a ? b : a;
      const facetType = classifyFacet(primary, line);
      if (facetType !== "Unclassified") {
        addCandidate(candidateMap, { term: primary, alias, facetType, sourceFile: filePath, line, method: "bilingual_or_heading" });
      }
    });
  });

  [...strongLines, ...sentences].forEach((line) => {
    extractCandidatePhrases(line).forEach((term) => {
      const facetType = classifyFacet(term, line);
      if (facetType !== "Unclassified") {
        addCandidate(candidateMap, { term, facetType, sourceFile: filePath, line, method: isHeadingLike(line) ? "heading" : "phrase_rule" });
      }
    });
  });
}

function finalizeCandidates(candidateMap, minCount) {
  return [...candidateMap.values()]
    .filter((item) => item.counts.mentions >= minCount || item.extraction_methods.includes("bilingual_or_heading"))
    .map((item) => {
      const strongSource = item.extraction_methods.includes("bilingual_or_heading") || item.extraction_methods.includes("heading");
      const highFrequency = item.counts.mentions >= 5 && item.counts.documents >= 2;
      return {
        ...item,
        document_paths: undefined,
        confidence_bucket: strongSource || highFrequency ? "high_seed_candidate" : "medium_seed_candidate",
        aliases: item.aliases.slice(0, 12),
      };
    })
    .sort((a, b) => {
      if (a.facet_type !== b.facet_type) return a.facet_type.localeCompare(b.facet_type);
      if (b.counts.documents !== a.counts.documents) return b.counts.documents - a.counts.documents;
      return b.counts.mentions - a.counts.mentions;
    });
}

function buildReport({ inputDir, files, candidates }) {
  const byFacet = FACET_TYPES.map((facet) => ({
    facet,
    terms: candidates.filter((item) => item.facet_type === facet),
  }));

  const lines = [
    "# Guideline Seed Vocabulary Report",
    "",
    `- Input: ${inputDir}`,
    `- Files processed: ${files.length}`,
    `- Candidate terms: ${candidates.length}`,
    `- Status: guideline_seed_candidate only; not expert_confirmed`,
    "",
    "## Files",
    ...files.map((file) => `- ${file}`),
    "",
    "## Facet Summary",
    ...byFacet.map(({ facet, terms }) => `- ${facet}: ${terms.length}`),
    "",
  ];

  byFacet.forEach(({ facet, terms }) => {
    lines.push(`## ${facet}`, "");
    terms.slice(0, 40).forEach((term) => {
      lines.push(`- ${term.canonical_name} (${term.counts.mentions} mentions / ${term.counts.documents} docs)`);
    });
    lines.push("");
  });

  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv);
  const inputDir = path.resolve(args.input);
  const files = walkFiles(inputDir);
  const candidateMap = new Map();

  files.forEach((file) => {
    const text = convertDocumentToText(file);
    if (!text.trim()) return;
    extractFromDocument(file, text, candidateMap);
  });

  const candidates = finalizeCandidates(candidateMap, args.minCount);
  const payload = {
    schema_version: "0.1",
    generated_at: new Date().toISOString(),
    input_dir: inputDir,
    policy: {
      status: "guideline_seed_candidate",
      note: "Terms are extracted from human-authored guidelines, but extraction is automated. Do not treat them as expert_confirmed.",
      no_auto_promotion_without_seed_calibration: true,
    },
    files,
    candidates,
  };

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(args.report, buildReport({ inputDir, files, candidates }));

  console.log(`Processed ${files.length} files`);
  console.log(`Wrote ${candidates.length} candidates to ${args.output}`);
  console.log(`Report: ${args.report}`);
}

main();
