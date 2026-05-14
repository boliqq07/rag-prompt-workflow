#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_FIXTURE_DIR = path.join(ROOT, "eval", "fixtures");

function parseArgs(argv) {
  const args = {
    baseUrl: "http://127.0.0.1:8080",
    fixtures: "all",
    fixtureDir: DEFAULT_FIXTURE_DIR,
    limit: 5,
    allowRemoteLlm: false,
    allowProjectRemote: false,
    liveKnowledge: false,
    minScore: 0,
    outDir: path.join(ROOT, "reports"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--base-url") args.baseUrl = argv[++index];
    else if (item === "--fixtures") args.fixtures = argv[++index];
    else if (item === "--fixture-dir") args.fixtureDir = path.resolve(argv[++index]);
    else if (item === "--limit") args.limit = Number(argv[++index]) || args.limit;
    else if (item === "--allow-remote-llm") args.allowRemoteLlm = true;
    else if (item === "--allow-project-remote") args.allowProjectRemote = true;
    else if (item === "--live-knowledge") args.liveKnowledge = true;
    else if (item === "--min-score") args.minScore = Number(argv[++index]) || args.minScore;
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
  --fixture-dir DIR                 Fixture directory. Default: ./eval/fixtures
  --allow-remote-llm                Use questionMode=llm and promptMode=llm for synthetic fixtures
  --allow-project-remote            Also allow project fixtures to be sent to remote LLM
  --live-knowledge                  Retrieve project RAG fixtures from the running knowledge service
  --min-score N                     Exit with failure if any fixture scores below N
  --limit N                         Knowledge retrieval limit. Default: 5
  --base-url URL                    Local app URL. Default: http://127.0.0.1:8080
  --out-dir DIR                     Report directory. Default: ./reports
`);
}

async function readFixtureFile(filePath) {
  const payload = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.fixtures)) return payload.fixtures;
  throw new Error(`Invalid fixture file: ${filePath}`);
}

async function selectFixtures(args) {
  const groups = args.fixtures === "all" ? ["synthetic", "project"] : [args.fixtures];
  const fixtures = [];
  for (const group of groups) {
    fixtures.push(...(await readFixtureFile(path.join(args.fixtureDir, `${group}.json`))));
  }
  return fixtures;
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

function getFixtureKnowledgeResults(fixture) {
  if (Array.isArray(fixture.knowledgeResults) && fixture.knowledgeResults.length) {
    return fixture.knowledgeResults;
  }
  if (fixture.knowledge) {
    return [
      {
        title: `Fixture knowledge: ${fixture.id}`,
        knowledge_source_label: "Fixture snapshot",
        source_type: "fixture",
        text: fixture.knowledge,
      },
    ];
  }
  return [];
}

async function retrieveKnowledge(baseUrl, fixture, args) {
  const fixtureKnowledgeResults = getFixtureKnowledgeResults(fixture);
  if (fixtureKnowledgeResults.length && !args.liveKnowledge) {
    return {
      results: fixtureKnowledgeResults,
      errors: [],
      knowledge: fixture.knowledge || knowledgeToText(fixtureKnowledgeResults),
    };
  }

  if (fixture.sourceMode !== "rag" || !fixture.collections?.length) {
    return { results: [], errors: [], knowledge: "" };
  }
  const payload = await postJson(baseUrl, "/api/knowledge/search", {
    query: fixture.prompt,
    collections: fixture.collections,
    limit: args.limit,
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
  const requiredEvidenceTypes = fixture.requiredEvidenceTypes || [];
  const requiredPromptPhrases = fixture.requiredPromptPhrases || [];
  const requiredQuestionIds = fixture.requiredQuestionIds || [];

  function aliases(term) {
    const table = {
      "gamma prime": ["gamma prime", "γ'", "γ'强化相"],
      "γ'强化相": ["γ'强化相", "gamma prime", "γ'strengtheningphase"],
      高温合金: ["高温合金", "superalloy", "high temperature alloy"],
    };
    return fixture.termAliases?.[term] || table[term] || [term];
  }

  function includesTerm(haystack, term) {
    const lowered = haystack.toLowerCase();
    return aliases(term).some((alias) => lowered.includes(String(alias).toLowerCase()));
  }

  const retrievalHits = required.filter((term) => includesTerm(searchableKnowledge, term));
  const questionHits = required.filter((term) => includesTerm(candidateText, term));
  const promptHits = required.filter((term) => includesTerm(promptText, term));
  const forbiddenMentioned = forbidden.filter((term) => promptText.toLowerCase().includes(term.toLowerCase()));
  const evidenceTypeHits = requiredEvidenceTypes.filter((item) => promptText.toLowerCase().includes(String(item).toLowerCase()));
  const promptPhraseHits = requiredPromptPhrases.filter((item) => promptText.toLowerCase().includes(String(item).toLowerCase()));
  const questionIds = new Set(questions.map((question) => question.id));
  const questionIdHits = requiredQuestionIds.filter((item) => questionIds.has(item));
  const hasNoMergeLanguage = /不能合并|不得.*合并|严禁.*合并|禁止.*合并|不应合并|独立概念|not merge|must not/i.test(
    promptText
  );

  const retrievalScore = fixture.sourceMode === "rag" ? retrievalHits.length / Math.max(required.length, 1) : 1;
  const questionScore = questionHits.length / Math.max(required.length, 1);
  const promptScore = promptHits.length / Math.max(required.length, 1);
  const boundaryScore = forbidden.length ? (forbiddenMentioned.length / forbidden.length) * (hasNoMergeLanguage ? 1 : 0) : 1;
  const evidenceScore = requiredEvidenceTypes.length ? evidenceTypeHits.length / requiredEvidenceTypes.length : 1;
  const promptPhraseScore = requiredPromptPhrases.length ? promptPhraseHits.length / requiredPromptPhrases.length : 1;
  const questionIdScore = requiredQuestionIds.length ? questionIdHits.length / requiredQuestionIds.length : 1;
  const scoreDimensions = [
    ["retrieval", retrievalScore],
    ["question", questionScore],
    ["prompt", promptScore],
    ["boundary", boundaryScore],
    ["evidence", evidenceScore],
  ];
  if (requiredPromptPhrases.length) scoreDimensions.push(["promptPhrase", promptPhraseScore]);
  if (requiredQuestionIds.length) scoreDimensions.push(["questionId", questionIdScore]);
  const total = Math.round((scoreDimensions.reduce((sum, [, score]) => sum + score, 0) / scoreDimensions.length) * 100);

  const diagnostics = [];
  const missingRetrievalTerms = required.filter((term) => !retrievalHits.includes(term));
  const missingQuestionTerms = required.filter((term) => !questionHits.includes(term));
  const missingPromptTerms = required.filter((term) => !promptHits.includes(term));
  const missingForbiddenBoundaryTerms = forbidden.filter((term) => !forbiddenMentioned.includes(term));
  const missingEvidenceTypes = requiredEvidenceTypes.filter((item) => !evidenceTypeHits.includes(item));
  const missingPromptPhrases = requiredPromptPhrases.filter((item) => !promptPhraseHits.includes(item));
  const missingQuestionIds = requiredQuestionIds.filter((item) => !questionIdHits.includes(item));

  if (missingRetrievalTerms.length && fixture.sourceMode === "rag") {
    diagnostics.push(`召回缺失：${missingRetrievalTerms.join("；")}`);
  }
  if (missingQuestionTerms.length) diagnostics.push(`候选问题缺失：${missingQuestionTerms.join("；")}`);
  if (missingPromptTerms.length) diagnostics.push(`最终提示词缺失：${missingPromptTerms.join("；")}`);
  if (missingForbiddenBoundaryTerms.length) diagnostics.push(`不合并边界缺失：${missingForbiddenBoundaryTerms.join("；")}`);
  if (forbidden.length && !hasNoMergeLanguage) diagnostics.push("最终提示词缺少明确的不合并/禁止合并措辞");
  if (missingEvidenceTypes.length) diagnostics.push(`证据类型缺失：${missingEvidenceTypes.join("；")}`);
  if (missingPromptPhrases.length) diagnostics.push(`必需提示词短语缺失：${missingPromptPhrases.join("；")}`);
  if (missingQuestionIds.length) diagnostics.push(`必需问题缺失：${missingQuestionIds.join("；")}`);

  return {
    total,
    dimensions: Object.fromEntries(scoreDimensions),
    retrievalScore,
    questionScore,
    promptScore,
    boundaryScore,
    promptPhraseScore,
    questionIdScore,
    retrievalHits,
    questionHits,
    promptHits,
    forbiddenMentioned,
    evidenceTypeHits,
    promptPhraseHits,
    questionIdHits,
    missingRetrievalTerms,
    missingQuestionTerms,
    missingPromptTerms,
    missingForbiddenBoundaryTerms,
    missingEvidenceTypes,
    missingPromptPhrases,
    missingQuestionIds,
    diagnostics,
    hasNoMergeLanguage,
    evidenceScore,
  };
}

async function runOne(baseUrl, fixture, args) {
  const remoteAllowedForFixture =
    args.allowRemoteLlm && (fixture.sensitivity === "synthetic" || args.allowProjectRemote);
  const retrieval = await retrieveKnowledge(baseUrl, fixture, args);
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
  const formatScore = (value) => Number(value || 0).toFixed(2);
  const lines = [
    "# 工作流质量评测报告",
    "",
    `- 生成时间：${new Date().toISOString()}`,
    `- Fixtures：${args.fixtures}`,
    `- Fixture 目录：${path.relative(ROOT, args.fixtureDir) || "."}`,
    `- 远端 LLM：${args.allowRemoteLlm ? "synthetic enabled" : "disabled"}`,
    `- 项目知识远端发送：${args.allowProjectRemote ? "enabled" : "disabled"}`,
    `- 知识来源：${args.liveKnowledge ? "live knowledge service" : "fixture snapshot"}`,
    `- 最低分阈值：${args.minScore || "未启用"}`,
    "",
    "## 汇总",
    "",
    "| 用例 | 模式 | 分数 | 召回 | 问题候选 | 最终提示词 | 边界 | 证据 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const item of results) {
    lines.push(
      `| ${item.label} | ${item.mode} | ${item.score.total} | ${formatScore(item.score.retrievalScore)} | ${formatScore(item.score.questionScore)} | ${formatScore(item.score.promptScore)} | ${formatScore(item.score.boundaryScore)} | ${formatScore(item.score.evidenceScore)} |`
    );
  }

  lines.push("", "## 详情", "");
  for (const item of results) {
    const retrieval = item.retrieval || { topTitles: [] };
    const score = {
      questionHits: [],
      promptHits: [],
      forbiddenMentioned: [],
      evidenceTypeHits: [],
      promptPhraseHits: [],
      questionIdHits: [],
      diagnostics: [],
      ...item.score,
    };
    lines.push(
      `### ${item.label}`,
      "",
      `- Workflow：${item.workflow}`,
      `- Sensitivity：${item.sensitivity}`,
      `- Mode：${item.mode}`,
      `- Score：${score.total}`,
      item.error ? `- Error：${item.error}` : "",
      `- Retrieval top：${retrieval.topTitles.join("；") || "无"}`,
      `- Required in questions：${score.questionHits.join("；") || "无"}`,
      `- Required in final prompt：${score.promptHits.join("；") || "无"}`,
      `- Forbidden boundary mentioned：${score.forbiddenMentioned.join("；") || "无"}`,
      `- Evidence type hits：${score.evidenceTypeHits.join("；") || "无"}`,
      `- Required prompt phrases：${score.promptPhraseHits.join("；") || "无"}`,
      `- Required question ids：${score.questionIdHits.join("；") || "无"}`,
      `- Diagnostics：${score.diagnostics.join("；") || "无"}`,
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
  const fixtures = await selectFixtures(args);
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

  const failed = results.filter((item) => item.score.total < args.minScore);
  if (failed.length) {
    console.error(`\nQuality gate failed: ${failed.map((item) => `${item.id}=${item.score.total}`).join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
