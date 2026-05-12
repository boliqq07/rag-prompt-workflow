#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_INPUT = path.join(process.cwd(), "data", "guideline-seed-vocab.json");
const DEFAULT_OUTPUT = path.join(process.cwd(), "data", "guideline-seed-vocab-cleaned.json");
const DEFAULT_REPORT = path.join(process.cwd(), "data", "guideline-seed-vocab-cleaned.md");
const ENV_FILE = path.join(process.cwd(), ".env");

const ACTIONS = new Set(["keep", "discard", "merge_alias"]);
const FACET_ORDER = [
  "PhysicalComponent",
  "FailureMode",
  "EngineeringFeature",
  "DesignControl",
  "ParameterLimit",
  "BoundaryCondition",
  "TestCondition",
];

const DISCARD_PATTERNS = [
  /^table of contents$/i,
  /^annex\s+\d+$/i,
  /^figure\s+\d+/i,
  /^gb\/t\s+\d+/i,
  /^sae\s+/i,
  /design guideline$/i,
  /revision\s+\d+/i,
  /\bthe following documents\b/i,
  /\bjust like\b/i,
  /\blike the\b/i,
  /\brefer to\b/i,
  /\bn\/a\b/i,
  /^[a-z]\s+/i,
];

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    report: DEFAULT_REPORT,
    dryRun: false,
    mock: false,
    model: "",
    maxTermsPerFacet: 120,
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
    } else if (current === "--model" && next) {
      args.model = next;
      index += 1;
    } else if (current === "--max-terms-per-facet" && next) {
      args.maxTermsPerFacet = Number(next) || args.maxTermsPerFacet;
      index += 1;
    } else if (current === "--dry-run") {
      args.dryRun = true;
    } else if (current === "--mock") {
      args.mock = true;
    }
  }

  return args;
}

function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return {};

  const env = {};
  fs.readFileSync(ENV_FILE, "utf8")
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) return;
      const key = trimmed.slice(0, separatorIndex).trim();
      const rawValue = trimmed.slice(separatorIndex + 1).trim();
      env[key] = rawValue.replace(/^["']|["']$/g, "");
    });
  return env;
}

function normalizeLLMContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => normalizeLLMContent(item)).filter(Boolean).join("\n");
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
    throw new Error("LLM did not return a JSON object.");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

function compactCandidate(candidate) {
  return {
    vocab_id: candidate.vocab_id,
    canonical_name: candidate.canonical_name,
    facet_type: candidate.facet_type,
    aliases: candidate.aliases || [],
    confidence_bucket: candidate.confidence_bucket,
    counts: candidate.counts,
    methods: candidate.extraction_methods || [],
    evidence: (candidate.sources || []).slice(0, 2).map((source) => ({
      document: source.document,
      text: source.evidence_text,
    })),
  };
}

function normalizeTerm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[（）()]/g, " ")
    .replace(/[_\-&/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shouldDiscardByRule(candidate) {
  const name = candidate.canonical_name || "";
  if (!name || name.length < 2) return "empty_or_too_short";
  if (DISCARD_PATTERNS.some((pattern) => pattern.test(name))) return "non_domain_heading_or_reference";
  if (/^[a-z\s]+$/i.test(name) && name.split(/\s+/).length > 6) return "sentence_fragment";
  if (/^[\d\s.,;:()/%\-]+$/.test(name)) return "numeric_fragment";
  return "";
}

function mockCleanFacet(facet, candidates) {
  const byNormalized = new Map();
  const decisions = [];

  candidates.forEach((candidate) => {
    const discardReason = shouldDiscardByRule(candidate);
    if (discardReason) {
      decisions.push({
        source_vocab_id: candidate.vocab_id,
        action: "discard",
        canonical_source_vocab_id: null,
        canonical_name: candidate.canonical_name,
        aliases: [],
        reason: discardReason,
        confidence: 0.72,
      });
      return;
    }

    const normalized = normalizeTerm(candidate.canonical_name);
    if (byNormalized.has(normalized)) {
      const target = byNormalized.get(normalized);
      decisions.push({
        source_vocab_id: candidate.vocab_id,
        action: "merge_alias",
        canonical_source_vocab_id: target.vocab_id,
        canonical_name: target.canonical_name,
        aliases: [candidate.canonical_name, ...(candidate.aliases || [])],
        reason: "same_normalized_surface_form",
        confidence: 0.78,
      });
      return;
    }

    byNormalized.set(normalized, candidate);
    decisions.push({
      source_vocab_id: candidate.vocab_id,
      action: "keep",
      canonical_source_vocab_id: candidate.vocab_id,
      canonical_name: candidate.canonical_name,
      aliases: candidate.aliases || [],
      reason: "mock_keep_no_rule_rejection",
      confidence: candidate.confidence_bucket === "high_seed_candidate" ? 0.82 : 0.68,
    });
  });

  return {
    facet_type: facet,
    decisions,
  };
}

function buildPrompt(facet, candidates) {
  return [
    {
      role: "system",
      content:
        "你是工业连接器 guideline 词表清洗器。你只能在给定候选词中做 keep、discard、merge_alias 三种动作，严禁新增候选词或创造新的 canonical 概念。必须只返回 JSON。",
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          task: "clean_guideline_seed_vocabulary",
          facet_type: facet,
          rules: [
            "keep: 保留确实是该 facet_type 的工业术语、部件、失效模式、工程特征、设计控制或参数项。",
            "discard: 丢弃目录标题、章节说明、完整句子片段、图号、标准引用、非术语短语、N/A、泛化说明。",
            "merge_alias: 如果两个候选表示同一概念，把较差/别名项合并到给定候选中的一个 canonical_source_vocab_id。",
            "不要把上下位关系合并为 alias。例如 限位结构 与 轴向限位结构 不是同义词，除非文本明确说是同一概念。",
            "不要跨 facet 合并。不要改变 facet_type。不要输出输入列表之外的 canonical_source_vocab_id。",
            "保守优先：不确定时 keep，但 reason 写明 low_confidence_keep。",
          ],
          output_schema: {
            decisions: [
              {
                source_vocab_id: "string from input",
                action: "keep | discard | merge_alias",
                canonical_source_vocab_id: "source vocab_id if keep or merge_alias, otherwise null",
                canonical_name: "existing candidate name only",
                aliases: ["strings from candidate names or aliases"],
                reason: "short reason",
                confidence: "number 0-1",
              },
            ],
          },
          candidates: candidates.map(compactCandidate),
        },
        null,
        2
      ),
    },
  ];
}

async function callLLM({ env, model, messages }) {
  const baseUrl = (env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const pathName = env.LLM_CHAT_COMPLETIONS_PATH || "/chat/completions";
  const apiKey = env.LLM_API_KEY || "";
  const selectedModel = model || env.LLM_MODEL || "gpt-4.1";

  if (!apiKey) {
    throw new Error("LLM_API_KEY is not configured. Set it in .env or run with --mock.");
  }

  const response = await fetch(`${baseUrl}${pathName}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: selectedModel,
      messages,
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  });

  const rawText = await response.text();
  if (!response.ok) {
    const error = new Error(`LLM request failed with status ${response.status}.`);
    error.detail = rawText.slice(0, 2000);
    throw error;
  }

  const data = JSON.parse(rawText);
  return normalizeLLMContent(data.choices?.[0]?.message?.content);
}

function validateDecision(decision, candidateIds) {
  const action = ACTIONS.has(decision.action) ? decision.action : "keep";
  const sourceId = String(decision.source_vocab_id || "");
  if (!candidateIds.has(sourceId)) return null;

  let canonicalSourceId = decision.canonical_source_vocab_id || null;
  if (action === "keep") canonicalSourceId = sourceId;
  if (action === "merge_alias" && !candidateIds.has(canonicalSourceId)) canonicalSourceId = sourceId;
  if (action === "discard") canonicalSourceId = null;

  return {
    source_vocab_id: sourceId,
    action: action === "merge_alias" && canonicalSourceId === sourceId ? "keep" : action,
    canonical_source_vocab_id: canonicalSourceId,
    canonical_name: String(decision.canonical_name || ""),
    aliases: Array.isArray(decision.aliases) ? decision.aliases.map(String).slice(0, 20) : [],
    reason: String(decision.reason || "no_reason"),
    confidence: typeof decision.confidence === "number" ? Math.max(0, Math.min(1, decision.confidence)) : null,
  };
}

async function cleanFacet({ facet, candidates, env, model, useMock }) {
  const limitedCandidates = candidates.slice(0, Number.MAX_SAFE_INTEGER);
  if (useMock) return mockCleanFacet(facet, limitedCandidates);

  const content = await callLLM({
    env,
    model,
    messages: buildPrompt(facet, limitedCandidates),
  });
  const payload = extractJsonObject(content);
  const decisions = Array.isArray(payload.decisions) ? payload.decisions : [];
  return {
    facet_type: facet,
    decisions,
  };
}

function applyDecisions(inputPayload, facetResults) {
  const candidateById = new Map(inputPayload.candidates.map((candidate) => [candidate.vocab_id, candidate]));
  const rawDecisionById = new Map();

  facetResults.forEach((facetResult) => {
    const candidateIds = new Set(
      inputPayload.candidates
        .filter((candidate) => candidate.facet_type === facetResult.facet_type)
        .map((candidate) => candidate.vocab_id)
    );
    (facetResult.decisions || []).forEach((decision) => {
      const validated = validateDecision(decision, candidateIds);
      if (validated) rawDecisionById.set(validated.source_vocab_id, validated);
    });
  });

  const cleaned = [];
  const discarded = [];
  const missing = [];

  inputPayload.candidates.forEach((candidate) => {
    const decision = rawDecisionById.get(candidate.vocab_id);
    if (!decision) {
      missing.push(candidate.vocab_id);
      cleaned.push({
        ...candidate,
        status: "guideline_seed_candidate_cleaned",
        clean_action: "keep",
        clean_reason: "missing_llm_decision_default_keep",
        clean_confidence: null,
      });
      return;
    }

    if (decision.action === "discard") {
      discarded.push({
        ...candidate,
        status: "discarded_by_vocab_cleaner",
        clean_action: "discard",
        clean_reason: decision.reason,
        clean_confidence: decision.confidence,
      });
      return;
    }

    if (decision.action === "merge_alias") {
      const target = candidateById.get(decision.canonical_source_vocab_id);
      if (!target) {
        cleaned.push({
          ...candidate,
          status: "guideline_seed_candidate_cleaned",
          clean_action: "keep",
          clean_reason: "merge_target_missing_default_keep",
          clean_confidence: decision.confidence,
        });
        return;
      }
      const targetExisting = cleaned.find((item) => item.vocab_id === target.vocab_id);
      const aliasPayload = [candidate.canonical_name, ...(candidate.aliases || []), ...decision.aliases].filter(Boolean);
      if (targetExisting) {
        targetExisting.aliases = [...new Set([...(targetExisting.aliases || []), ...aliasPayload])].slice(0, 30);
        targetExisting.merged_from = [...new Set([...(targetExisting.merged_from || []), candidate.vocab_id])];
      } else {
        cleaned.push({
          ...target,
          aliases: [...new Set([...(target.aliases || []), ...aliasPayload])].slice(0, 30),
          status: "guideline_seed_candidate_cleaned",
          clean_action: "keep",
          clean_reason: "target_of_merge_alias",
          clean_confidence: decision.confidence,
          merged_from: [candidate.vocab_id],
        });
      }
      return;
    }

    cleaned.push({
      ...candidate,
      aliases: [...new Set([...(candidate.aliases || []), ...decision.aliases])].slice(0, 30),
      status: "guideline_seed_candidate_cleaned",
      clean_action: "keep",
      clean_reason: decision.reason,
      clean_confidence: decision.confidence,
    });
  });

  const dedupedCleaned = [...new Map(cleaned.map((item) => [item.vocab_id, item])).values()];

  return {
    schema_version: "0.2",
    generated_at: new Date().toISOString(),
    input_vocab_file: inputPayload.input_dir || "",
    policy: {
      status: "guideline_seed_candidate_cleaned",
      note: "LLM cleaner can only keep, discard, or merge aliases among input candidates. Output is not expert_confirmed and not canonical.",
      allowed_actions: [...ACTIONS],
      no_new_canonical_terms: true,
    },
    files: inputPayload.files || [],
    candidates: dedupedCleaned,
    discarded_candidates: discarded,
    cleaner_audit: {
      total_input_candidates: inputPayload.candidates.length,
      total_output_candidates: dedupedCleaned.length,
      total_discarded: discarded.length,
      total_missing_decisions: missing.length,
      missing_decision_ids: missing.slice(0, 50),
      facet_results: facetResults,
    },
  };
}

function countByFacet(items) {
  return items.reduce((acc, item) => {
    acc[item.facet_type] = (acc[item.facet_type] || 0) + 1;
    return acc;
  }, {});
}

function buildReport(payload) {
  const keptByFacet = countByFacet(payload.candidates);
  const discardedByFacet = countByFacet(payload.discarded_candidates);
  const lines = [
    "# Cleaned Guideline Seed Vocabulary Report",
    "",
    `- Generated: ${payload.generated_at}`,
    `- Status: ${payload.policy.status}`,
    `- Input candidates: ${payload.cleaner_audit.total_input_candidates}`,
    `- Output candidates: ${payload.cleaner_audit.total_output_candidates}`,
    `- Discarded: ${payload.cleaner_audit.total_discarded}`,
    `- Missing LLM decisions default-kept: ${payload.cleaner_audit.total_missing_decisions}`,
    `- Note: not expert_confirmed; not canonical`,
    "",
    "## Facet Summary",
    ...FACET_ORDER.map(
      (facet) => `- ${facet}: kept ${keptByFacet[facet] || 0}, discarded ${discardedByFacet[facet] || 0}`
    ),
    "",
  ];

  FACET_ORDER.forEach((facet) => {
    const terms = payload.candidates.filter((candidate) => candidate.facet_type === facet);
    if (!terms.length) return;
    lines.push(`## ${facet}`, "");
    terms.slice(0, 60).forEach((candidate) => {
      const aliases = candidate.aliases?.length ? ` aliases: ${candidate.aliases.slice(0, 5).join(" / ")}` : "";
      const merged = candidate.merged_from?.length ? ` merged_from: ${candidate.merged_from.length}` : "";
      lines.push(`- ${candidate.canonical_name} (${candidate.clean_reason || "kept"}; confidence=${candidate.clean_confidence ?? "n/a"}${merged})${aliases}`);
    });
    lines.push("");
  });

  if (payload.discarded_candidates.length) {
    lines.push("## Discarded Samples", "");
    payload.discarded_candidates.slice(0, 80).forEach((candidate) => {
      lines.push(`- ${candidate.canonical_name} [${candidate.facet_type}] - ${candidate.clean_reason}`);
    });
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  const inputPayload = JSON.parse(fs.readFileSync(args.input, "utf8"));
  const env = loadEnvFile();
  const candidatesByFacet = new Map();

  inputPayload.candidates.forEach((candidate) => {
    if (!candidatesByFacet.has(candidate.facet_type)) candidatesByFacet.set(candidate.facet_type, []);
    candidatesByFacet.get(candidate.facet_type).push(candidate);
  });

  const facets = FACET_ORDER.filter((facet) => candidatesByFacet.has(facet));
  const planned = facets.map((facet) => ({
    facet,
    candidates: candidatesByFacet.get(facet).length,
  }));

  if (args.dryRun) {
    console.log(JSON.stringify({ input: args.input, output: args.output, model: args.model || env.LLM_MODEL || "", planned }, null, 2));
    return;
  }

  const facetResults = [];
  for (const facet of facets) {
    const candidates = candidatesByFacet.get(facet).slice(0, args.maxTermsPerFacet);
    console.log(`${args.mock ? "Mock cleaning" : "LLM cleaning"} ${facet}: ${candidates.length} candidates`);
    const result = await cleanFacet({
      facet,
      candidates,
      env,
      model: args.model,
      useMock: args.mock,
    });
    facetResults.push(result);
  }

  const cleanedPayload = applyDecisions(inputPayload, facetResults);
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(cleanedPayload, null, 2)}\n`);
  fs.writeFileSync(args.report, buildReport(cleanedPayload));

  console.log(`Wrote ${cleanedPayload.candidates.length} cleaned candidates to ${args.output}`);
  console.log(`Discarded ${cleanedPayload.discarded_candidates.length} candidates`);
  console.log(`Report: ${args.report}`);
}

main().catch((error) => {
  console.error(error.message);
  if (error.detail) console.error(error.detail);
  process.exit(1);
});
