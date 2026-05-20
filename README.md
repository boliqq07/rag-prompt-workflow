# RAG 智能体问答系统

一个本地 Web 应用，用来把用户的原始模糊提示词逐步细化为可执行、可导出的规范提示词。应用包含前端工作台和 Python 后端代理，可真实接入 OpenAI-compatible LLM。

## 当前能力

- 支持两种知识来源模式：
  - `无 RAG 知识库`：基于通用领域知识组织问答选项。
  - `附带 RAG 知识库`：优先从 Milvus 或粘贴知识片段中提取候选术语、英文别名、同义词组和禁止合并边界。
- 支持多种中间问答类型：
  - 单选
  - 多选
  - 判断
  - 补充说明
- 支持动态问答编排：
  - 从原始 prompt 中自动识别任务类型、输出格式、合并策略和执行约束。
  - 已明确的信息会自动回答并跳过，减少重复提问。
  - 自动回答会保留在会话状态中，最终提示词仍会使用这些约束。
- 支持归纳输出：
  - 可执行抽取提示词实时生成
  - 继续追问修改
  - 按当前预览格式导出 `.txt`、`.md` 或 `.json`
- 支持可审计质量保障：
  - 工作流黄金评测覆盖合成样例和项目样例。
  - 评测会分项检查召回、候选问题、最终提示词、边界、证据类型、自动回答和实际提问路径。
  - 当前 `npm run review` 要求全部 fixture 达到 `100` 分。

## 交互流程

1. 用户输入原始模糊提示词，例如 `提取文中钢结构的性能词条`。
2. 系统识别任务场景，并根据通用模板或 RAG 术语片段组织问题。
3. 后端 Orchestrator 会自动回答 prompt 中已经明确的问题，例如 `JSON 数组`、`严格合并`、`证据原文` 等约束。
4. 用户只需要继续确认仍有歧义的内容，例如候选词条、同义词组、补充边界。
5. 系统实时归纳为可执行提示词，并允许用户继续追问修改。
6. 用户导出最终提示词，用于后续抽取链路或智能体调用。

## 平台扩展边界

当前版本已进入后端编排阶段。前端主流程会优先调用后端 Orchestrator；如果后端不可用，才回退到浏览器内置模板。主后端已经迁移为 Python，实现会话状态、问题推进、提示词生成、知识检索、上传文档和持久化存储。

- `知识库检索服务`：根据原始提示词召回术语、标准条目、同义词、字段模板。
- `问答编排服务`：基于任务类型动态生成单选、多选、判断和补充说明问题。
- `提示词生成服务`：把用户确认结果归纳成稳定模板，并保留版本记录。
- `执行与评估服务`：把规范提示词送入抽取链路，回写抽取结果和用户反馈。

## 效果优化进展

当前分支已经完成五个效果优化阶段：

1. `评测闭环增强`：评测报告会输出缺失术语、缺失证据类型、缺失 prompt 短语、低价值问题未跳过等诊断。
2. `知识 metadata 结构化`：Excel、Markdown、词典和网页知识片段统一写入 `schema_version`、`source_id`、`canonical_name`、`aliases`、`definition`、`evidence_type` 等字段。
3. `检索重排增强`：检索脚本支持领域 query expansion，例如 `屈服强度 -> yield strength / YS / Rp0.2`，并返回 `match_reasons` 解释排序依据。
4. `同义词决策矩阵`：证据类型会统一映射到等级、动作和关系类型，例如 `excel_includes_parameter -> A / 自动合并 / 字段涵盖参数`。
5. `动态问答编排`：已由 prompt 明确回答的问题会自动填充并跳过，减少不必要的交互。

这些阶段都纳入 `npm run review`，当前完整评测覆盖 `13` 个 fixture，要求全部达到 `100` 分。

## 后端编排 API

后端 Orchestrator 位于 [backend/orchestrator.py](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/backend/orchestrator.py)。会话状态会同时保存在内存和本地 SQLite 中，默认目录为 `data/runtime`，可用 `RUNTIME_STORE_DIR` 覆盖。它提供以下接口：

创建会话：

```bash
curl -s -X POST http://127.0.0.1:8080/api/orchestrator/sessions \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"提取文中钢结构的性能指标","sourceMode":"generic","questionMode":"local"}'
```

获取会话：

```bash
curl -s http://127.0.0.1:8080/api/orchestrator/sessions/<sessionId>
```

列出已保存会话：

```bash
curl -s http://127.0.0.1:8080/api/orchestrator/sessions
```

查看某个会话的最终提示词版本：

```bash
curl -s http://127.0.0.1:8080/api/orchestrator/sessions/<sessionId>/prompt-versions
```

会话响应会包含：

- `questions`：完整问题定义，供前端展示步骤和候选项。
- `currentQuestion`：当前实际需要用户回答的问题。
- `answers`：用户答案和后端自动填充答案的合并结果。
- `autoAnswers`：后端从原始 prompt 中自动推断的答案，以及跳过原因。
- `questionSource` / `promptSource`：问题和最终提示词来自本地模板还是 LLM。

提交当前问题答案并推进下一题：

```bash
curl -s -X POST http://127.0.0.1:8080/api/orchestrator/sessions/<sessionId>/answers \
  -H 'Content-Type: application/json' \
  -d '{"questionId":"business_role","answer":"材料数据抽取员","customAnswer":""}'
```

生成最终提示词：

```bash
curl -s -X POST http://127.0.0.1:8080/api/orchestrator/sessions/<sessionId>/finalize \
  -H 'Content-Type: application/json' \
  -d '{"promptMode":"local"}'
```

`questionMode` 可取：

- `local`：后端模板生成问答流程。
- `llm`：后端调用 LLM 生成问答流程。

`promptMode` 可取：

- `local`：后端规则归纳最终提示词。
- `llm`：后端调用 LLM 归纳最终提示词。

## 启动 Web 应用

先准备环境配置：

```bash
cp .env.example .env
```

编辑 `.env`，填入你的模型配置。然后启动：

```bash
npm start
```

`npm start` 默认启动 [server.py](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/server.py)。如果需要对照旧版 Node 实现，可运行：

```bash
npm run start:node
```

访问：

```bash
http://127.0.0.1:8080
```

如果暂时不配置 `LLM_API_KEY`，应用仍可启动，本地模板问答流程仍然可用；只是 `LLM 生成问答` 和 `LLM 归纳提示词` 会保持禁用。

## 依赖安装说明

基础演示只需要 Python 3 和浏览器即可运行：

```bash
npm start
```

这种模式可以展示前端工作台、Python 后端编排、本地模板问答、会话持久化、上传文本和本地哈希向量兜底检索。

如果要完整展示真实 RAG 链路，建议额外安装 Milvus Lite 依赖：

```bash
python3 -m pip install -r requirements-rag.txt
```

`requirements-rag.txt` 主要包含：

- `pymilvus[milvus_lite]`：本地 Milvus Lite collection、上传文档入库、真实向量检索。
- `openpyxl`：读取 Excel 知识源。
- `setuptools`：兼容部分 Python 包运行时依赖。

未安装 `pymilvus` 时，系统不会崩溃；上传文档会继续写入 SQLite，并使用本地哈希向量检索兜底。但页面和接口会显示 Milvus 入库失败信息。给老师演示“真实文档作为 RAG 输入源”时，推荐先安装 `requirements-rag.txt`，这样上传文档会同时写入 `kb_uploaded_documents` collection。

## 知识库入库：Excel + 标准网站 + 材料词典

新增的 Milvus 入库脚本位于 [scripts/ingest_knowledge.py](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/scripts/ingest_knowledge.py)，检索自测脚本位于 [scripts/search_knowledge.py](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/scripts/search_knowledge.py)。当前实现对齐 Milvus 官方快速开始的 Milvus Lite 路径：本地使用 `pymilvus`，数据写入一个 `.db` 文件；后续切到 Docker/K8s Milvus 时，只需要把客户端连接参数替换为服务端 URI。

首次写入或检索 Milvus collection 前，先安装 RAG 依赖：

```bash
python3 -m pip install -r requirements-rag.txt
```

先做不写库的抽取预览：

```bash
python3 scripts/ingest_knowledge.py --dry-run --site-max-pages 5
```

正式写入本地 Milvus Lite。推荐按数据源拆成独立 collection：

```bash
python3 scripts/ingest_knowledge.py --reset --skip-site --collection kb_hydrogen_excel
python3 scripts/ingest_knowledge.py --reset --skip-default-excel --site-url https://std.samr.gov.cn/ --site-max-pages 30 --site-depth 2 --collection kb_samr_standards
python3 scripts/ingest_knowledge.py --reset --skip-default-excel --skip-site --default-markdown --markdown-start-heading 专业分类目录 --markdown-mode term --collection kb_material_dictionary
```

当前支持三类数据：

- Excel：微信临时目录中的 `氢脆应力应变曲线抽取要求-A0.xlsx`，按工作表、原始行号、字段名、定义、涵盖参数、数据类型、相关要求、举例等信息切成知识片段。
- 网站：[全国标准信息公共服务平台](https://std.samr.gov.cn/)，默认从首页开始，限制抓取 `std.samr.gov.cn` 与 `openstd.samr.gov.cn`，并通过 `--site-max-pages` 和 `--site-depth` 控制规模，避免一次性抓取整站。
- Markdown 词典：`材料大辞典第二版.md` 使用 `--markdown-mode term` 按术语条目切分，跳过书籍前置信息、编委会、专业目录和英文索引。

每条知识片段会在 `metadata_json` 中写入统一结构化字段，用于检索重排、同义词证据和前端健康检查：

- `schema_version`、`source_id`、`source_type`、`source_title`
- `canonical_name`、`aliases`、`definition`
- `field_name`、`unit`、`data_type`、`section`
- `evidence_type`，例如 `excel_includes_parameter`、`dictionary_alias`、`dictionary_see_also`、`web_page`

旧字段如 `term`、`english`、`workbook`、`sheet`、`row_number` 仍会保留在 metadata 中，以兼容已有检索和调试脚本。

入库后检索自测：

```bash
python3 scripts/search_knowledge.py "氢脆 应力应变曲线 测试条件" --collection kb_hydrogen_excel --limit 5
python3 scripts/search_knowledge.py "国家标准 全文公开 公告" --collection kb_samr_standards --limit 5
python3 scripts/search_knowledge.py "泡沫玻璃 多孔玻璃 保温材料" --collection kb_material_dictionary --limit 5
```

检索会使用向量召回加词面重排。词面重排会同时查看标题、正文和结构化 metadata，并支持内置 query expansion：

- `屈服强度`、`yield strength` 会扩展到 `YS`、`σ0.2`、`Rp0.2`。
- `强度损失率`、`strength loss ratio` 会扩展到 `percentage loss of strength`、`reduction in strength`、`IUTS`。
- `泡沫玻璃`、`foam glass` 会扩展到 `多孔玻璃`、`porous glass`。
- `gamma prime` 会扩展到 `γ'`、`γ'强化相`。

每条检索结果会返回 `match_reasons`，用于解释命中来自 metadata、标题还是正文，例如：

```json
{
  "title": "氢脆 Excel / yield strength name",
  "rerank_score": 12.4,
  "match_reasons": [
    "metadata:yield strength:query_phrase",
    "metadata:Rp0.2:expanded_from:屈服强度"
  ]
}
```

## 工作流质量评测

工作流评测脚本位于 [scripts/evaluate-workflows.js](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/scripts/evaluate-workflows.js)。黄金评测集位于 [eval/fixtures](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/eval/fixtures)，按 `synthetic.json` 和 `project.json` 拆分。它会固定跑一组同义词合并和提示词生成用例，检查知识召回、候选问题、最终提示词、“不应合并”边界、证据类型和动态问答路径是否覆盖预期项。

本地完整自动审查：

```bash
npm run review
```

该命令会执行：

- `npm run check`：Node 兼容代码语法检查 + Python 后端语法检查。
- 启动一个临时本地服务。
- 跑全部黄金评测集。
- 要求每条 fixture 分数达到 `100`，否则返回失败码。

当前评测维度包括：

- `retrievalScore`：RAG 用例的 fixture 知识或 live knowledge 是否覆盖必需术语。
- `questionScore`：候选问题是否覆盖必需术语。
- `promptScore`：最终提示词是否覆盖必需术语。
- `boundaryScore`：禁止合并项是否被明确列出，并包含“不应合并/禁止合并”等措辞。
- `evidenceScore`：最终提示词是否包含必需证据类型，例如 `dictionary_alias`、`category_type_conflict`。
- `promptPhraseScore`：最终提示词是否包含必需短语，例如 `JSON 数组`、`输出前检查`、`决策：自动合并`。
- `autoAnsweredScore`：动态问答是否自动回答了指定问题。
- `forbiddenAskedScore`：低价值问题是否被跳过。
- `askedCountScore`：实际提问数量是否低于 fixture 约束。

默认评测不会调用远端 LLM，也不会把项目知识发到外部模型：

```bash
npm run eval:workflows
```

CI 使用的是 fixture 内的小型知识快照，不依赖本地 Milvus DB。需要测试真实 Milvus 检索链路时，先启动 Web 服务并确保知识库已经入库，然后运行：

```bash
node scripts/evaluate-workflows.js --fixtures project --live-knowledge --min-score 100
```

仅用合成样例测试远端 LLM 分支：

```bash
node scripts/evaluate-workflows.js --fixtures synthetic --allow-remote-llm
```

报告会写入 `reports/workflow-eval-*.json` 和 `reports/workflow-eval-*.md`。如果要把真实项目知识片段发送到远端 LLM，需要显式增加 `--allow-project-remote`，正常开发评测不建议默认开启。

新增黄金评测样例时，优先修改 `eval/fixtures/*.json`，不要直接把样例写回脚本。每条 fixture 至少包含：

- `prompt`：原始需求。
- `workflow`：流程类型，例如 `prompt_generation`（完整提示词生成，包含术语确认）或 `synonym_merge`（仅同义词合并专用工具）。
- `requiredTerms`：最终问题和提示词中必须覆盖的术语。
- `forbiddenMergeTerms`：必须明确标记为“不合并”的边界项。
- `answers`：模拟用户确认过程。
- `knowledgeResults`：项目类样例推荐提供小型知识快照，保证 CI 可离线审查。

可选字段用于更细粒度约束：

- `requiredEvidenceTypes`：最终提示词必须出现的证据类型。
- `requiredPromptPhrases`：最终提示词必须出现的关键短语。
- `requiredQuestionIds`：问题定义中必须存在的问题。
- `requiredAutoAnsweredIds`：应由后端自动回答并跳过的问题。
- `forbiddenAskedQuestionIds`：不应再次询问用户的问题。
- `maxAskedQuestions`：动态问答实际提问数量上限。
- `termAliases`：评测用的术语别名表。

GitHub Actions 配置位于 [.github/workflows/ci.yml](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/.github/workflows/ci.yml)。每次 push 到 `main` 或创建 PR 时，会自动运行 `npm run review`。

## 同义词合并决策

同义词确认步骤会按证据等级输出四类关系：

- `A`：知识库强证据，可自动合并，例如 Excel `涵盖参数`、词典 `又称`、`见/参见`。
- `B`：内置词典或缩写建议合并，需要保留证据。
- `C`：相关但不合并，例如 `yield strength` 与 `tensile strength` 同属强度类性能，但缺少同义证据。
- `D`：禁止合并，例如字段类型冲突、材料名 vs 性能指标、试验条件 vs 测量结果、强度值 vs 强度损失率。

后端内置了证据决策矩阵，会把 `evidenceType` 统一映射为证据等级、动作和关系类型：

| evidenceType | 等级 | 动作 | 关系类型 |
| --- | --- | --- | --- |
| `excel_includes_parameter` | A | 自动合并 | 字段涵盖参数 |
| `dictionary_alias` | A | 自动合并 | 词典又称 |
| `dictionary_see_also` | A | 自动合并 | 词典见/参见 |
| `bilingual_alias` | B | 建议合并 | 中英文别名 |
| `abbreviation` / `symbol_alias` | B | 建议合并 | 缩写/符号 |
| `related_only` | C | 相关但不合并 | 同类相关 |
| `field_type_conflict` | D | 禁止合并 | 字段类型冲突 |
| `metric_type_conflict` | D | 禁止合并 | 指标类型冲突 |
| `semantic_boundary_conflict` | D | 禁止合并 | 语义边界冲突 |
| `category_type_conflict` | D | 禁止合并 | 信息类别冲突 |

标准名选择会优先选择字段名、中文术语或完整英文短语，避免把 `YS`、`σ0.2`、`Rp0.2` 这类缩写或符号误设为 canonical。

当前内置边界规则包括：

- `name / value / unit / ratio / rate` 等同基字段类型冲突。
- `strength` 与 `strength loss / reduction in strength / IUTS` 等语义边界冲突。
- `ratio / rate / value` 等指标类型冲突。
- 材料名或材料类别与性能指标、测量结果、试验条件冲突。
- 试验条件与测量结果/性能指标冲突。
- 知识片段中出现 `不能与 ... 合并` 这类显式边界时，会生成 D 级禁止合并项。

最终提示词会分区列出“自动/确认合并项”“相关但不合并项”“禁止合并项”，并保留 `evidenceType` 和证据说明。黄金评测集会检查关键证据类型是否出现在最终提示词中。

Web 应用启动后会暴露知识库接口：

```bash
curl -s http://127.0.0.1:8080/api/knowledge/status
curl -s -X POST http://127.0.0.1:8080/api/knowledge/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"氢脆 应力应变曲线 测试条件","limit":5}'
```

也可以直接上传真实文档作为 RAG 输入源。前端左侧“关联知识源”卡片提供文件选择入口；后端接口接受 `txt`、`md`、`csv`、`json`、`html`、`pdf`、`docx`、`xlsx`，会先抽取文本，再写入 SQLite 和 Milvus Lite 的 `kb_uploaded_documents` collection；如果 Milvus 入库失败，会保留本地哈希向量兜底检索：

```bash
curl -s -X POST http://127.0.0.1:8080/api/knowledge/uploads \
  -H 'Content-Type: application/json' \
  -d '{"filename":"sample.md","content":"# 屈服强度\nYS、Rp0.2 和 yield strength 在本规范中视为同义表达。"}'
```

上传后的文档会显示为 `上传文档` 知识源，可与其他 Milvus collection 一起检索，也可单独检索：

```bash
curl -s -X POST http://127.0.0.1:8080/api/knowledge/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"yield strength Rp0.2","collections":["uploaded_documents"],"limit":5}'
```

`/api/knowledge/status` 会返回每个知识源的管理状态，包括：

- `health` / `healthLabel`：`ready`、`missing_db`、`missing_collection`、`empty`、`unknown` 等状态。
- `rowCount`：当前 collection 中的知识片段数量。
- `lastUpdated`：本地 Milvus DB 或上传文档最近更新时间。
- `sampleTitles`：用于快速判断入库内容的样例标题。
- `healthMessage`：缺库、空库或依赖缺失时的具体说明。

页面左侧“关联知识源”卡片会展示这些状态，并可点击“刷新状态”重新检测。未入库或空库的知识源会禁用勾选，避免误以为已经接入。

页面中把模式切到 `RAG 知识库` 后，点击“模板生成问答”或“LLM 生成问答”会先按原始提示词召回知识片段，再把召回文本交给后端 Orchestrator 生成候选词条与同义词组。

后端默认暴露三个可选知识源：

- `氢脆 Excel 抽取要求` -> `kb_hydrogen_excel`
- `全国标准信息公共服务平台` -> `kb_samr_standards`
- `材料大辞典第二版` -> `kb_material_dictionary`
- `上传文档` -> `kb_uploaded_documents`，本地兜底 collection 标识为 `local_uploaded_documents`

前端可以多选知识源。生成问答时，后端会分别检索被选中的 collection，按向量相似度和术语词面命中重排后合并召回结果，并保留 `knowledge_source_label`、`collection`、`source_type`、`source_uri` 等来源信息。上传文档支持删除、重新上传和查看索引状态；删除会清理本地记录并尝试删除对应 Milvus 主键。

## 持久化存储

默认运行数据写入 `data/runtime/runtime.sqlite`，该目录已加入 `.gitignore`，避免上传真实业务文档、答案和审计日志。主要表如下：

- `sessions`：会话、问题、答案、自动回答、最终提示词和更新时间。
- `answers`：按 `session_id/question_id` 保存答案快照。
- `prompt_versions`：每次 finalize 生成的提示词版本、答案快照和生成方式。
- `uploaded_documents`：上传文件 metadata、抽取文本、Milvus collection、Milvus 主键和入库状态。
- `document_chunks`：上传文档的本地向量兜底检索片段。
- `audit_logs`：创建会话、提交答案、跳转问题、生成提示词、上传/删除文档等审计事件。
- `settings`：可选保存本机 LLM 接口配置。API Key 不会提交到 Git，但如果勾选“记住到本机”，会写入本机 `runtime.sqlite`。

如果要把这些数据切到外部数据库，优先替换 [backend/storage.py](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/backend/storage.py) 的实现，保持同一组读写函数即可。

## 自由文本证据解析

RAG 片段除了结构化 `字段/涵盖参数/同义词组` 写法，也会解析常见自然语言证据：

- `A、B、C 表示同一字段，可作为同义/别名合并到 X` -> A 级 `exact_alias`。
- `A 又称/也称/等价于 B` -> A 级 `dictionary_alias`。
- `A 缩写为/简称/符号为 B` -> B 级 `abbreviation`。
- `A 不能与 B 合并` -> D 级禁止合并边界。

这让直接上传普通说明文档时，也能稳定生成自动合并、建议合并和禁止合并证据。

## 动态问答编排

后端会在创建会话时读取原始 prompt，自动推断已经明确的信息：

- `target_type`：例如 `材料术语归一`、`信息抽取`、`抽取字段标准化`。
- `output_format`：例如 `JSON 数组`、`JSON 对象`、`Markdown 表格`、`CSV 字段`。
- `bilingual_synonym`：是否需要同义词、别名、中英文或缩写处理。
- `merge_policy`：例如 `严格合并`、`人工复核优先`、`宽松聚类`。
- `constraints`：例如 `证据原文`、`关系类型`、`不合并原因`、`人工复核标记`、`输出前自检`。

示例 prompt：

```text
请做材料术语归一：严格合并 foam glass、porous glass，并保留证据原文、关系类型、不合并原因和人工复核标记；输出 JSON 数组。
```

后端会自动填充：

```json
{
  "target_type": "材料术语归一",
  "merge_policy": "严格合并",
  "output_format": "JSON 数组",
  "constraints": ["证据原文", "关系类型", "不合并原因", "人工复核标记"]
}
```

这些问题不会再次询问用户，但答案会保存在 `answers` 和 `autoAnswers` 中，最终提示词仍会引用它们。对应 fixture `synthetic-dynamic-question-pruning` 会检查自动回答和实际提问数量，防止后续改动让低价值问题重新出现。

默认 `EMBEDDING_MODE=hash` 使用本地哈希向量，适合先跑通 Milvus 入库与检索链路，不需要额外模型下载。正式做语义检索时，建议在 `.env` 中切换为 OpenAI-compatible embedding：

```env
EMBEDDING_MODE=openai
EMBEDDING_DIM=1536
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_API_KEY=你的 API Key
```

## 真实接入 LLM

后端代理 [server.py](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/server.py) 支持 OpenAI-compatible Chat Completions 接口。API Key 可以放在服务端 `.env` / 环境变量中，也可以在页面左侧 `LLM 接入` 卡片中配置。页面只把 Key 发送到本机后端，不会在 `/api/config` 或 `/api/health` 中回显明文。

OpenAI 示例：

```env
LLM_API_KEY=你的 API Key
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4.1
```

如果使用兼容 OpenAI 协议的国产模型或私有模型，只需要替换：

```env
LLM_API_KEY=你的 API Key
LLM_BASE_URL=你的兼容接口地址，例如 https://.../v1
LLM_MODEL=你的模型名
```

运行时也可以通过前端设置：

- `接口地址`：OpenAI-compatible `/v1` 基础地址。
- `API Key`：留空保存时会保留当前 Key。
- `基础模型`：使用左侧基础模型下拉框的当前值；若后端返回新模型名，会自动加入下拉框。
- `记住到本机`：勾选后写入 `data/runtime/runtime.sqlite` 的 `settings` 表；不勾选则仅在当前 server 进程内生效。

页面会自动检测 `/api/health`：

- `LLM 生成问答`：调用模型，根据原始需求和 RAG 术语片段动态生成追问问题与候选项。
- `LLM 归纳提示词`：调用模型，把用户确认答案整理成最终可执行抽取提示词。
- 未配置 Key 或直接打开 HTML 时，本地模板流程仍然可用。

## 文件结构

- [index.html](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/index.html)：页面结构
- [styles.css](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/styles.css)：视觉样式
- [app.js](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/app.js)：前端渲染、用户输入收集、后端编排 API 调用与兜底逻辑
- [server.py](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/server.py)：Python 静态文件服务、LLM 后端代理、知识库与上传文档 API
- [backend/orchestrator.py](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/backend/orchestrator.py)：Python 后端会话编排器
- [backend/storage.py](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/backend/storage.py)：Python SQLite 持久化存储、提示词版本、上传文档和审计日志
- [server.js](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/server.js)：旧版 Node 后端兼容实现，用于回归对照
- [backend/orchestrator.js](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/backend/orchestrator.js)：旧版 Node 会话编排器兼容实现
- [backend/storage.js](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/backend/storage.js)：旧版 Node SQLite 存储兼容实现
- [scripts/extract_upload_text.py](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/scripts/extract_upload_text.py)：上传文档文本抽取
- [scripts/index_uploaded_document.py](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/scripts/index_uploaded_document.py)：上传文档写入 Milvus
- [scripts/delete_uploaded_document.py](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/scripts/delete_uploaded_document.py)：删除上传文档的 Milvus 记录
- [scripts/ingest_knowledge.py](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/scripts/ingest_knowledge.py)：Excel、Markdown、网站知识入库
- [scripts/search_knowledge.py](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/scripts/search_knowledge.py)：Milvus 检索、query expansion 和重排
- [scripts/evaluate-workflows.js](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/scripts/evaluate-workflows.js)：工作流质量评测
- [eval/fixtures](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/eval/fixtures)：黄金评测集
- [package.json](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/package.json)：应用启动脚本
- [.env.example](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/.env.example)：环境变量模板

## 后续建议

当前版本已经具备可审计评测、结构化知识 metadata、检索解释、同义词决策矩阵、动态问答编排、真实文件上传、Milvus 上传索引、SQLite 持久化和前端会话/版本/审计视图。下一阶段建议优先做 `最终 prompt schema 化`：

1. 固定最终 prompt 结构：角色、任务目标、输入说明、字段范围、同义词规则、不合并边界、证据要求、输出 schema、空值策略、质量自检。
2. 为抽取类任务生成 JSON Schema，例如 `standard_term`、`original_text`、`evidence_sentence`、`confidence`、`notes`。
3. 为同义词合并任务生成结果 schema，例如 `canonical_name`、`aliases`、`relation_type`、`evidence_type`、`review_required`、`do_not_merge`。
4. 把 schema 字段纳入 `evaluate-workflows.js` 评测，避免最终提示词退化为松散自然语言。
5. 后续再接抽取链路执行、外部数据库迁移和用户反馈闭环。
