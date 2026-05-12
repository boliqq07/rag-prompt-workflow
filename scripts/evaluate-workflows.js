#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const PROJECT_FIXTURES = [
  {
    id: "excel-yield-strength",
    label: "Excel: yield strength aliases",
    sensitivity: "project",
    workflow: "synonym_merge",
    sourceMode: "rag",
    collections: ["hydrogen_excel"],
    prompt: "合并 yield strength、YS、σ0.2、Rp0.2 的同义词项，并说明 yield strength value 与 yield strength name 是否能合并。",
    requiredTerms: ["yield strength", "YS", "σ0.2", "Rp0.2"],
    forbiddenMergeTerms: ["yield strength value"],
    answers: {
      target_type: "抽取字段标准化",
      candidate_terms: ["yield strength name", "yield strength", "YS", "σ0.2", "Rp0.2", "yield strength value"],
      bilingual_synonym: "yes",
      synonym_groups: ["yield strength name"],
      merge_policy: "严格合并",
      output_format: "JSON 数组",
      constraints: ["知识来源", "证据原文", "关系类型", "置信度", "不合并原因"],
      extra_instructions: "yield strength value 与 yield strength name 不能合并；名称字段和数值字段必须分开。",
    },
  },
  {
    id: "excel-strength-loss-ratio",
    label: "Excel: strength loss ratio aliases",
    sensitivity: "project",
    workflow: "synonym_merge",
    sourceMode: "rag",
    collections: ["hydrogen_excel"],
    prompt: "合并 strength loss ratio、percentage loss of strength、reduction in strength、IUTS 的同义词项。",
    requiredTerms: ["strength loss ratio", "percentage loss of strength", "reduction in strength", "IUTS"],
    forbiddenMergeTerms: ["抗拉强度"],
    answers: {
      target_type: "抽取字段标准化",
      candidate_terms: ["strength loss ratio name", "strength loss ratio", "percentage loss of strength", "reduction in strength", "IUTS"],
      bilingual_synonym: "yes",
      synonym_groups: ["strength loss ratio name"],
      merge_policy: "严格合并",
      output_format: "JSON 数组",
      constraints: ["知识来源", "证据原文", "关系类型", "置信度", "不合并原因"],
      extra_instructions: "强度值、抗拉强度和强度损失率不能合并。",
    },
  },
  {
    id: "dict-foam-glass",
    label: "Dictionary: foam glass aliases",
    sensitivity: "project",
    workflow: "synonym_merge",
    sourceMode: "rag",
    collections: ["material_dictionary"],
    prompt: "判断泡沫玻璃和多孔玻璃是否可以作为同义词合并，并保留词典证据。",
    requiredTerms: ["泡沫玻璃", "多孔玻璃"],
    forbiddenMergeTerms: ["泡沫塑料"],
    answers: {
      target_type: "材料术语归一",
      candidate_terms: ["泡沫玻璃", "多孔玻璃", "泡沫塑料"],
      bilingual_synonym: "yes",
      synonym_groups: ["泡沫玻璃"],
      merge_policy: "严格合并",
      output_format: "Markdown 表格",
      constraints: ["知识来源", "证据原文", "关系类型", "置信度", "不合并原因"],
      extra_instructions: "泡沫塑料不能与泡沫玻璃合并。",
    },
  },
  {
    id: "dict-gamma-prime",
    label: "Dictionary: gamma prime strengthening phase",
    sensitivity: "project",
    workflow: "synonym_merge",
    sourceMode: "rag",
    collections: ["material_dictionary"],
    prompt: "判断 gamma prime、γ'强化相、高温合金强化相之间的合并边界。",
    requiredTerms: ["γ'强化相", "gamma prime", "高温合金"],
    forbiddenMergeTerms: ["γ''强化相"],
    answers: {
      target_type: "材料术语归一",
      candidate_terms: ["γ'强化相", "gamma prime", "高温合金", "γ''强化相"],
      bilingual_synonym: "yes",
      synonym_groups: ["γ'强化相"],
      merge_policy: "人工复核优先",
      output_format: "JSON 数组",
      constraints: ["知识来源", "证据原文", "关系类型", "置信度", "不合并原因", "人工复核标记"],
      extra_instructions: "γ'强化相与 γ''强化相不能直接合并。",
    },
  },
];

const SYNTHETIC_FIXTURES = [
  {
    id: "synthetic-synonym-alpha",
    label: "Synthetic: alpha synonym merge",
    sensitivity: "synthetic",
    workflow: "synonym_merge",
    sourceMode: "generic",
    prompt: "请把测试术语 alpha strength、AS、A0.2 合并为同义词组，并生成可审计输出规则。注意 beta loss 是不同概念，不能合并。",
    requiredTerms: ["alpha strength", "AS", "A0.2", "beta loss"],
    forbiddenMergeTerms: ["beta loss"],
    answers: {
      target_type: "抽取字段标准化",
      candidate_terms: ["alpha strength", "AS", "A0.2", "beta loss"],
      bilingual_synonym: "yes",
      synonym_groups: ["alpha strength"],
      merge_policy: "严格合并",
      output_format: "JSON 数组",
      constraints: ["证据原文", "关系类型", "置信度", "不合并原因"],
      extra_instructions: "beta loss 不得与 alpha strength 合并。",
    },
  },
  {
    id: "synthetic-field-type-boundary",
    label: "Synthetic: field type boundary",
    sensitivity: "synthetic",
    workflow: "synonym_merge",
    sourceMode: "generic",
    prompt:
      "判断 alpha name、alpha value、alpha unit、alpha ratio、alpha rate 的合并边界；这些字段类型相近但不能互相合并。",
    requiredTerms: ["alpha name", "alpha value", "alpha unit", "alpha ratio", "alpha rate"],
    forbiddenMergeTerms: ["alpha value", "alpha unit", "alpha ratio", "alpha rate"],
    answers: {
      target_type: "字段边界判定",
      candidate_terms: ["alpha name", "alpha value", "alpha unit", "alpha ratio", "alpha rate"],
      bilingual_synonym: "yes",
      synonym_groups: [],
      merge_policy: "严格合并",
      output_format: "JSON 数组",
      constraints: ["关系类型", "置信度", "不合并原因"],
      extra_instructions: "alpha name、alpha value、alpha unit、alpha ratio、alpha rate 都是不同字段类型，禁止相互合并。",
    },
  },
  {
    id: "synthetic-prompt-alpha",
    label: "Synthetic: prompt generation",
    sensitivity: "synthetic",
    workflow: "prompt_generation",
    sourceMode: "generic",
    prompt: "生成一个用于测试文档中抽取 alpha metric、test condition、sample id 的高质量提示词；要求 JSON 输出和证据句。",
    requiredTerms: ["alpha metric", "test condition", "sample id"],
    forbiddenMergeTerms: [],
    answers: {
      business_role: "材料数据抽取员",
      target_type: "信息抽取",
      candidate_terms: ["alpha metric", "test condition", "sample id"],
      output_format: "JSON 数组",
      constraints: ["只基于原文", "保留原文证据句", "输出前自检", "不确定时标记待确认"],
      extra_instructions: "不要输出推理过程；没有证据时输出 null。",
    },
  },
];

function parseArgs(argv) {
  const args = {
    baseUrl: "http://127.0.0.1:8080",
    fixtures: "all",
    limit: 5,
    allowRemoteLlm: false,
    allowProjectRemote: false,
    outDir: path.join(ROOT, "reports"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--base-url") args.baseUrl = argv[++index];
    else if (item === "--fixtures") args.fixtures = argv[++index];
    else if (item === "--limit") args.limit = Number(argv[++index]) || args.limit;
    else if (item === "--allow-remote-llm") args.allowRemoteLlm = true;
    else if (item === "--allow-project-remote") args.allowProjectRemote = true;
    else if (item === "--out-dir") args.outDir = path.resolve(argv[++index]);
    else if (item === "--help") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/evaluate-workflows.js [options]

Options:
  --fixtures synthetic|project|all  Fixture group to run. Default: all
  --allow-remote-llm                Use questionMode=llm and promptMode=llm for synthetic fixtures
  --allow-project-remote            Also allow project fixtures to be sent to remote LLM
  --limit N                         Knowledge retrieval limit. Default: 5
  --base-url URL                    Local app URL. Default: http://127.0.0.1:8080
  --out-dir DIR                     Report directory. Default: ./reports
`);
}

function selectFixtures(group) {
  if (group === "synthetic") return SYNTHETIC_FIXTURES;
  if (group === "project") return PROJECT_FIXTURES;
  return [...SYNTHETIC_FIXTURES, ...PROJECT_FIXTURES];
}

async function postJson(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${payload.error || "request failed"} ${payload.detail || ""}`.trim());
  }
  return payload;
}

async function getJson(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${payload.error || "request failed"} ${payload.detail || ""}`.trim());
  }
  return payload;
}

function truncateText(value, maxChars) {
  const text = String(value || "");
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

function knowledgeToText(results, maxChars = 1800) {
  return (results || [])
    .map((result, index) => {
      return [
        `命中 ${index + 1}`,
        `来源：${result.knowledge_source_label || result.source_type || ""}`,
        `标题：${result.title || ""}`,
        `内容：${truncateText(result.text || "", 420)}`,
      ].join("\n");
    })
    .join("\n\n")
    .slice(0, maxChars);
}

async function retrieveKnowledge(baseUrl, fixture, limit) {
  if (fixture.sourceMode !== "rag" || !fixture.collections?.length) {
    return { results: [], errors: [], knowledge: "" };
  }
  const payload = await postJson(baseUrl, "/api/knowledge/search", {
    query: fixture.prompt,
    collections: fixture.collections,
    limit,
  });
  return {
    results: payload.results || [],
    errors: payload.errors || [],
    knowledge: knowledgeToText(payload.results || []),
  };
}

function answerFor(question, fixture) {
  if (Object.prototype.hasOwnProperty.call(fixture.answers, question.id)) {
    return fixture.answers[question.id];
  }
  if (question.type === "multi") return [];
  if (question.type === "boolean") return "yes";
  return "";
}

async function runWorkflow(baseUrl, fixture, knowledge, useRemote) {
  let session = await postJson(baseUrl, "/api/orchestrator/sessions", {
    prompt: fixture.prompt,
    workflow: fixture.workflow,
    sourceMode: fixture.sourceMode,
    knowledge,
    questionMode: useRemote ? "llm" : "local",
    model: "qwen3.6-plus",
  });

  const initialQuestions = session.questions || [];
  let guard = 0;
  while (session.currentQuestion && guard < 30) {
    guard += 1;
    const question = session.currentQuestion;
    session = await postJson(baseUrl, `/api/orchestrator/sessions/${session.id}/answers`, {
      questionId: question.id,
      answer: answerFor(question, fixture),
      customAnswer: "",
    });
    if (question.id === "extra_instructions") break;
  }

  session = await postJson(baseUrl, `/api/orchestrator/sessions/${session.id}/finalize`, {
    promptMode: useRemote ? "llm" : "local",
    model: "qwen3.6-plus",
  });
  return { session, initialQuestions };
}

function questionOptionText(questions, id) {
  const question = questions.find((item) => item.id === id);
  return (question?.options || []).map((option) => option.label || option.value || "").join("\n");
}

function scoreFixture(fixture, knowledgeResults, questions, finalPrompt) {
  const searchableKnowledge = knowledgeResults.map((item) => `${item.title || ""}\n${item.text || ""}`).join("\n");
  const candidateText = questionOptionText(questions, "candidate_terms");
  const promptText = String(finalPrompt || "");
  const required = fixture.requiredTerms || [];
  const forbidden = fixture.forbiddenMergeTerms || [];

  function aliases(term) {
    const table = {
      "gamma prime": ["gamma prime", "γ'", "γ'强化相"],
      "γ'强化相": ["γ'强化相", "gamma prime", "γ'strengtheningphase"],
      高温合金: ["高温合金", "superalloy", "high temperature alloy"],
    };
    return table[term] || [term];
  }

  function includesTerm(haystack, term) {
    const lowered = haystack.toLowerCase();
    return aliases(term).some((alias) => lowered.includes(String(alias).toLowerCase()));
  }

  const retrievalHits = required.filter((term) => includesTerm(searchableKnowledge, term));
  const questionHits = required.filter((term) => includesTerm(candidateText, term));
  const promptHits = required.filter((term) => includesTerm(promptText, term));
  const forbiddenMentioned = forbidden.filter((term) => promptText.toLowerCase().includes(term.toLowerCase()));
  const hasNoMergeLanguage = /不能合并|不得.*合并|严禁.*合并|禁止.*合并|不应合并|独立概念|not merge|must not/i.test(
    promptText
  );

  const retrievalScore = fixture.sourceMode === "rag" ? retrievalHits.length / Math.max(required.length, 1) : 1;
  const questionScore = questionHits.length / Math.max(required.length, 1);
  const promptScore = promptHits.length / Math.max(required.length, 1);
  const boundaryScore = forbidden.length ? (forbiddenMentioned.length && hasNoMergeLanguage ? 1 : 0) : 1;
  const total = Math.round(((retrievalScore + questionScore + promptScore + boundaryScore) / 4) * 100);

  return {
    total,
    retrievalScore,
    questionScore,
    promptScore,
    boundaryScore,
    retrievalHits,
    questionHits,
    promptHits,
    forbiddenMentioned,
    hasNoMergeLanguage,
  };
}

async function runOne(baseUrl, fixture, args) {
  const remoteAllowedForFixture =
    args.allowRemoteLlm && (fixture.sensitivity === "synthetic" || args.allowProjectRemote);
  const retrieval = await retrieveKnowledge(baseUrl, fixture, args.limit);
  const { session, initialQuestions } = await runWorkflow(baseUrl, fixture, retrieval.knowledge, remoteAllowedForFixture);
  const score = scoreFixture(fixture, retrieval.results, initialQuestions, session.finalPrompt);
  return {
    id: fixture.id,
    label: fixture.label,
    workflow: fixture.workflow,
    sensitivity: fixture.sensitivity,
    mode: remoteAllowedForFixture ? "remote-llm" : "local-template",
    questionSource: session.questionSource,
    promptSource: session.promptSource,
    retrieval: {
      count: retrieval.results.length,
      errors: retrieval.errors,
      topTitles: retrieval.results.slice(0, 5).map((item) => item.title),
    },
    questions: initialQuestions.map((question) => ({
      id: question.id,
      title: question.title,
      optionPreview: (question.options || []).slice(0, 8).map((option) => option.label || option.value),
    })),
    score,
    finalPromptPreview: truncateText(session.finalPrompt || "", 1600),
  };
}

function renderMarkdown(results, args) {
  const lines = [
    "# 工作流质量评测报告",
    "",
    `- 生成时间：${new Date().toISOString()}`,
    `- Fixtures：${args.fixtures}`,
    `- 远端 LLM：${args.allowRemoteLlm ? "synthetic enabled" : "disabled"}`,
    `- 项目知识远端发送：${args.allowProjectRemote ? "enabled" : "disabled"}`,
    "",
    "## 汇总",
    "",
    "| 用例 | 模式 | 分数 | 召回 | 问题候选 | 最终提示词 | 边界 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const item of results) {
    lines.push(
      `| ${item.label} | ${item.mode} | ${item.score.total} | ${item.score.retrievalScore.toFixed(2)} | ${item.score.questionScore.toFixed(2)} | ${item.score.promptScore.toFixed(2)} | ${item.score.boundaryScore.toFixed(2)} |`
    );
  }

  lines.push("", "## 详情", "");
  for (const item of results) {
    lines.push(
      `### ${item.label}`,
      "",
      `- Workflow：${item.workflow}`,
      `- Sensitivity：${item.sensitivity}`,
      `- Mode：${item.mode}`,
      `- Score：${item.score.total}`,
      `- Retrieval top：${item.retrieval.topTitles.join("；") || "无"}`,
      `- Required in questions：${item.score.questionHits.join("；") || "无"}`,
      `- Required in final prompt：${item.score.promptHits.join("；") || "无"}`,
      `- Forbidden boundary mentioned：${item.score.forbiddenMentioned.join("；") || "无"}`,
      "",
      "Final prompt preview:",
      "",
      "```text",
      item.finalPromptPreview,
      "```",
      ""
    );
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixtures = selectFixtures(args.fixtures);
  await getJson(args.baseUrl, "/api/health");

  const results = [];
  for (const fixture of fixtures) {
    process.stderr.write(`Running ${fixture.id}...\n`);
    try {
      results.push(await runOne(args.baseUrl, fixture, args));
    } catch (error) {
      results.push({
        id: fixture.id,
        label: fixture.label,
        workflow: fixture.workflow,
        sensitivity: fixture.sensitivity,
        mode: "error",
        error: error.message,
        score: { total: 0 },
      });
    }
  }

  await fs.mkdir(args.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(args.outDir, `workflow-eval-${stamp}.json`);
  const mdPath = path.join(args.outDir, `workflow-eval-${stamp}.md`);
  await fs.writeFile(jsonPath, JSON.stringify({ args, results }, null, 2), "utf8");
  await fs.writeFile(mdPath, renderMarkdown(results, args), "utf8");

  const summary = results.map((item) => `${item.id}: ${item.score.total}`).join("\n");
  console.log(`Wrote:\n${jsonPath}\n${mdPath}\n\nScores:\n${summary}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
