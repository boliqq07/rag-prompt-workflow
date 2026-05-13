# RAG 智能体问答系统

一个本地 Web 应用，用来把用户的原始模糊提示词逐步细化为可执行、可导出的规范提示词。应用包含前端工作台和 Node.js 后端代理，可真实接入 OpenAI-compatible LLM。

## 当前能力

- 支持两种知识来源模式：
  - `无 RAG 知识库`：基于通用领域知识组织问答选项。
  - `附带 RAG 知识库`：优先从粘贴的知识库文本中提取候选术语、英文别名和同义词组。
- 支持多种中间问答类型：
  - 单选
  - 多选
  - 判断
  - 补充说明
- 支持归纳输出：
  - 可执行抽取提示词实时生成
  - 继续追问修改
  - 按当前预览格式导出 `.txt`、`.md` 或 `.json`

## 交互流程

1. 用户输入原始模糊提示词，例如 `提取文中钢结构的性能词条`。
2. 系统识别任务场景，并根据通用模板或 RAG 术语片段组织问题。
3. 用户逐步确认业务角色、抽取目标、候选词条、同义词归并、输出格式和质量约束。
4. 系统实时归纳为可执行提示词，并允许用户继续追问修改。
5. 用户导出最终提示词，用于后续抽取链路或智能体调用。

## 平台扩展边界

当前版本已进入后端编排阶段。前端主流程会优先调用后端 Orchestrator；如果后端不可用，才回退到浏览器内置模板。后端当前使用内存会话版 Orchestrator，用来承接会话状态、问题推进和提示词生成。

- `知识库检索服务`：根据原始提示词召回术语、标准条目、同义词、字段模板。
- `问答编排服务`：基于任务类型动态生成单选、多选、判断和补充说明问题。
- `提示词生成服务`：把用户确认结果归纳成稳定模板，并保留版本记录。
- `执行与评估服务`：把规范提示词送入抽取链路，回写抽取结果和用户反馈。

## 后端编排 API

后端 Orchestrator 位于 [backend/orchestrator.js](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/backend/orchestrator.js)，当前使用内存 `Map` 存储会话，服务重启后会话会丢失。它提供以下接口：

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

访问：

```bash
http://127.0.0.1:8080
```

如果暂时不配置 `LLM_API_KEY`，应用仍可启动，本地模板问答流程仍然可用；只是 `LLM 生成问答` 和 `LLM 归纳提示词` 会保持禁用。

## 知识库入库：Excel + 标准网站 + 材料词典

新增的 Milvus 入库脚本位于 [scripts/ingest_knowledge.py](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/scripts/ingest_knowledge.py)，检索自测脚本位于 [scripts/search_knowledge.py](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/scripts/search_knowledge.py)。当前实现对齐 Milvus 官方快速开始的 Milvus Lite 路径：本地使用 `pymilvus`，数据写入一个 `.db` 文件；后续切到 Docker/K8s Milvus 时，只需要把客户端连接参数替换为服务端 URI。

安装依赖：

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

入库后检索自测：

```bash
python3 scripts/search_knowledge.py "氢脆 应力应变曲线 测试条件" --collection kb_hydrogen_excel --limit 5
python3 scripts/search_knowledge.py "国家标准 全文公开 公告" --collection kb_samr_standards --limit 5
python3 scripts/search_knowledge.py "泡沫玻璃 多孔玻璃 保温材料" --collection kb_material_dictionary --limit 5
```

## 工作流质量评测

工作流评测脚本位于 [scripts/evaluate-workflows.js](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/scripts/evaluate-workflows.js)。黄金评测集位于 [eval/fixtures](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/eval/fixtures)，按 `synthetic.json` 和 `project.json` 拆分。它会固定跑一组同义词合并和提示词生成用例，检查知识召回、候选问题、最终提示词和“不应合并”边界是否覆盖预期项。

本地完整自动审查：

```bash
npm run review
```

该命令会执行：

- `npm run check`：Node 语法检查。
- 启动一个临时本地服务。
- 跑全部黄金评测集。
- 要求每条 fixture 分数达到 `100`，否则返回失败码。

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
- `workflow`：流程类型，例如 `synonym_merge` 或 `prompt_generation`。
- `requiredTerms`：最终问题和提示词中必须覆盖的术语。
- `forbiddenMergeTerms`：必须明确标记为“不合并”的边界项。
- `answers`：模拟用户确认过程。
- `knowledgeResults`：项目类样例推荐提供小型知识快照，保证 CI 可离线审查。

GitHub Actions 配置位于 [.github/workflows/ci.yml](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/.github/workflows/ci.yml)。每次 push 到 `main` 或创建 PR 时，会自动运行 `npm run review`。

Web 应用启动后会暴露知识库接口：

```bash
curl -s http://127.0.0.1:8080/api/knowledge/status
curl -s -X POST http://127.0.0.1:8080/api/knowledge/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"氢脆 应力应变曲线 测试条件","limit":5}'
```

页面中把模式切到 `Milvus 知识库` 后，点击“模板生成问答”或“LLM 生成问答”会先按原始提示词召回 Milvus 片段，再把召回文本交给后端 Orchestrator 生成候选词条与同义词组。

后端默认暴露两个可选知识源：

- `氢脆 Excel 抽取要求` -> `kb_hydrogen_excel`
- `全国标准信息公共服务平台` -> `kb_samr_standards`
- `材料大辞典第二版` -> `kb_material_dictionary`

前端可以多选知识源。生成问答时，后端会分别检索被选中的 collection，按向量相似度和术语词面命中重排后合并召回结果，并保留 `knowledge_source_label`、`collection`、`source_type`、`source_uri` 等来源信息。

默认 `EMBEDDING_MODE=hash` 使用本地哈希向量，适合先跑通 Milvus 入库与检索链路，不需要额外模型下载。正式做语义检索时，建议在 `.env` 中切换为 OpenAI-compatible embedding：

```env
EMBEDDING_MODE=openai
EMBEDDING_DIM=1536
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_API_KEY=你的 API Key
```

## 真实接入 LLM

后端代理 [server.js](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/server.js) 支持 OpenAI-compatible Chat Completions 接口。API Key 只放在服务端 `.env` 或环境变量中，不暴露给浏览器。

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

页面会自动检测 `/api/health`：

- `LLM 生成问答`：调用模型，根据原始需求和 RAG 术语片段动态生成追问问题与候选项。
- `LLM 归纳提示词`：调用模型，把用户确认答案整理成最终可执行抽取提示词。
- 未配置 Key 或直接打开 HTML 时，本地模板流程仍然可用。

## 文件结构

- [index.html](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/index.html)：页面结构
- [styles.css](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/styles.css)：视觉样式
- [app.js](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/app.js)：前端渲染、用户输入收集、后端编排 API 调用与兜底逻辑
- [server.js](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/server.js)：静态文件服务与 LLM 后端代理
- [backend/orchestrator.js](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/backend/orchestrator.js)：后端会话编排器
- [package.json](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/package.json)：应用启动脚本
- [.env.example](/Users/cyc/Desktop/相关文档/00-项目/szlab/RAG智能体问答系统/.env.example)：环境变量模板

## 后续建议

当前版本适合验证交互、后端编排 API 和 LLM 接入链路。下一步可以继续接：

1. 文件上传与向量检索，把真实文档作为 RAG 输入源。
2. 增加持久化存储，保存会话、答案、提示词版本和审计日志。
3. 增加 Orchestrator 的 schema 校验、重试和模型输出修复。
4. 大模型调用，把“归纳后的提示词”直接送入抽取链路执行。
