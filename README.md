# RAG 智能体问答系统

这是一个本地运行的 Web 应用，用来把一句模糊的任务需求，逐步整理成一份可以直接交给大模型执行的规范提示词。

它适合处理这类问题：

```text
请从文档中提取氢脆相关指标，并统一中英文术语和同义词。
```

系统会做三件事：

1. 追问用户还没有说清楚的约束。
2. 从上传文档或知识库里找术语、同义词和证据句。
3. 生成结构清晰、带证据要求、带输出格式约束的最终提示词。

## 快速启动

克隆项目后进入目录：

```bash
git clone https://github.com/chuyanchu/rag-prompt-workflow.git
cd rag-prompt-workflow
```

启动本地应用：

```bash
npm start
```

然后在浏览器打开：

```text
http://127.0.0.1:8080
```

不配置 API Key 也可以使用本地模板流程。配置 API Key 后，可以使用真实 LLM 生成问题流和归纳最终提示词。

## 一个真实例子

输入任务：

```text
请判断氢脆、hydrogen embrittlement、HE、hydrogen-induced cracking、腐蚀疲劳是否可以作为同义词合并；请区分确认合并、建议候选和不建议合并，并保留合并理由。
```

系统会得到类似结果：

| 关系 | 等级 | 处理结果 | 说明 |
| --- | --- | --- | --- |
| 氢脆 = hydrogen embrittlement / HE | B | 建议候选，需人工确认 | LLM 认为这是常见中英文术语和缩写，但没有文档证据时不直接自动合并 |
| 氢脆 vs hydrogen-induced cracking | C | 相关但不合并 | HIC 是氢损伤的具体表现之一，和广义氢脆相关，但不完全等价 |
| 氢脆 vs 腐蚀疲劳 | D | 禁止合并 | 腐蚀疲劳和氢脆是不同失效模式，不能作为同义词 |

最终提示词会把这些内容写成可执行规则：

```text
同义词确认结果：

自动/确认合并项：
- B|氢脆 => hydrogen embrittlement / HE；建议候选，需人工确认

相关但不合并项：
- C|氢脆 => hydrogen-induced cracking；相关但不合并

禁止合并项：
- D|氢脆 => 腐蚀疲劳；禁止合并
```

这个例子说明：系统允许 LLM 使用已有领域知识扩展候选词，但不会让 LLM 直接决定最终合并。最终结果仍要经过证据等级、RAG 文档证据和人工确认。

## 核心功能

- **提示词优化工作台**：把模糊需求拆成逐步确认的问题，最后生成规范提示词。
- **文件上传与 RAG 检索**：支持上传真实文本类文档，把文档作为知识来源参与检索。
- **同义词合并判断**：区分确认合并、建议候选、相关但不合并、禁止合并。
- **LLM 接入**：支持 OpenAI-compatible Chat Completions 接口，可以在前端配置 API 地址和 Key。
- **持久化存储**：保存会话、答案、提示词版本、上传文档和审计日志。
- **质量评测**：内置评测脚本，检查候选词、最终提示词、证据类型和不合并边界是否稳定。

## 基本使用流程

1. 在首页输入原始需求。
2. 选择是否使用 RAG 知识库。
3. 如需 RAG，上传文本、Markdown、CSV、JSON、HTML、PDF、DOCX 或 XLSX 文档。
4. 点击生成问题流。
5. 逐步确认候选词、同义词、输出格式和边界条件。
6. 生成最终提示词。
7. 根据需要继续修改或导出。

## 依赖安装

基础演示只需要 Python 3、Node.js 和浏览器：

```bash
npm start
```

如果要完整展示 Milvus Lite 向量检索，安装 RAG 依赖：

```bash
python3 -m pip install -r requirements-rag.txt
```

`requirements-rag.txt` 主要包含：

- `pymilvus[milvus_lite]`：本地向量库。
- `openpyxl`：读取 Excel 知识源。
- `setuptools`：兼容部分 Python 包运行依赖。

没有安装 `pymilvus` 时，系统仍能运行。上传文档会写入 SQLite，并使用本地哈希向量做兜底检索。

## LLM 配置

后端支持 OpenAI-compatible 接口。可以通过 `.env` 配置：

```env
LLM_API_KEY=你的 API Key
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4.1
```

也可以在页面左侧 `LLM 接入` 区域配置：

- `接口地址`：兼容 OpenAI 协议的 `/v1` 地址。
- `API Key`：只发送到本机后端，不会在页面回显明文。
- `基础模型`：当前使用的模型名。
- `记住到本机`：勾选后保存到本地 SQLite。

未配置 Key 时，本地模板流程仍可使用，只是 `模型生成问题流` 和 `LLM 生成提示词` 不可用。

## RAG 知识库

系统支持两种知识来源：

- `通用模板`：不依赖知识库，使用本地规则和内置示例。
- `RAG 文档`：从上传文档或 Milvus collection 中检索知识片段。

默认支持的知识源：

| 名称 | Collection | 用途 |
| --- | --- | --- |
| 氢脆 Excel 抽取要求 | `kb_hydrogen_excel` | 字段、参数、同义词和不合并边界 |
| 全国标准信息公共服务平台 | `kb_samr_standards` | 标准网站知识片段 |
| 材料大辞典第二版 | `kb_material_dictionary` | 材料术语、定义和别名 |
| 上传文档 | `kb_uploaded_documents` | 用户上传的真实文档 |

上传文档接口示例：

```bash
curl -s -X POST http://127.0.0.1:8080/api/knowledge/uploads \
  -H 'Content-Type: application/json' \
  -d '{"filename":"sample.md","content":"YS、Rp0.2 和 yield strength 在本规范中视为同义表达。"}'
```

检索上传文档：

```bash
curl -s -X POST http://127.0.0.1:8080/api/knowledge/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"yield strength Rp0.2","collections":["uploaded_documents"],"limit":5}'
```

## 同义词合并策略

系统不会简单地把“看起来相近”的词都合并，而是分成四个等级：

| 等级 | 含义 | 是否自动合并 |
| --- | --- | --- |
| A | 文档或词典中有明确证据 | 可以自动合并 |
| B | LLM、内置词典或缩写给出的候选 | 需要人工确认 |
| C | 相关但不完全等价 | 不合并，只保留边界 |
| D | 明确不同或容易误合并 | 禁止合并 |

前端显示为三栏：

- `确认合并`：证据明确，可以进入最终规则。
- `建议候选`：可能是同义词，但需要人工确认。
- `不建议合并`：相关但不等价，或明确禁止合并。

常见边界规则：

- `name / value / unit / ratio / rate` 等字段类型不同，不能直接合并。
- 材料名不能和性能指标、试验条件、测量结果合并。
- 强度值不能和强度损失率合并。
- 相关概念只能标记为相关，不能当成完全同义。

## 持久化存储

运行数据默认保存在：

```text
data/runtime/runtime.sqlite
```

保存内容包括：

- 会话记录
- 用户答案
- 自动回答
- 最终提示词版本
- 上传文档
- 文档切片
- 审计日志
- 本机 LLM 设置

`data/runtime` 已加入 `.gitignore`，不会把真实业务数据提交到 GitHub。

## 测试与评测

语法和编译检查：

```bash
npm run check
```

完整自动评测：

```bash
npm run review
```

评测脚本会检查：

- RAG 召回是否包含必要术语。
- 候选问题是否覆盖目标词。
- 最终提示词是否包含关键术语。
- 不应合并的边界是否明确写出。
- 证据类型是否保留。
- 已经在原始需求中说明的问题是否被自动跳过。

也可以单独运行工作流评测：

```bash
node scripts/evaluate-workflows.js --fixtures all --min-score 100
```

当前项目内置 13 个评测样例，覆盖同义词合并、字段边界、材料术语、RAG 证据和动态问答路径。

## 代码结构

| 路径 | 作用 |
| --- | --- |
| `index.html` | 页面结构 |
| `styles.css` | 页面样式 |
| `app.js` | 前端交互、状态管理和 API 调用 |
| `server.py` | Python 后端入口，提供静态服务、LLM 代理、知识库 API |
| `backend/orchestrator.py` | 问答编排、同义词判断、提示词生成 |
| `backend/storage.py` | SQLite 持久化存储 |
| `config/synonym_examples.json` | 内置同义词示例 |
| `config/query_expansions.json` | 检索扩展词配置 |
| `scripts/ingest_knowledge.py` | Excel、Markdown、网站知识入库 |
| `scripts/search_knowledge.py` | 知识库检索与重排 |
| `scripts/evaluate-workflows.js` | 工作流质量评测 |
| `eval/fixtures` | 黄金评测样例 |
| `requirements-rag.txt` | RAG 相关 Python 依赖 |

项目中还保留了 `server.js`、`backend/orchestrator.js` 和 `backend/storage.js` 作为旧版 Node 后端兼容实现。当前主线以后端 Python 版本为准。

## 后端 API 简览

创建会话：

```bash
curl -s -X POST http://127.0.0.1:8080/api/orchestrator/sessions \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"提取文中钢结构的性能指标","sourceMode":"generic","questionMode":"local"}'
```

提交答案：

```bash
curl -s -X POST http://127.0.0.1:8080/api/orchestrator/sessions/<sessionId>/answers \
  -H 'Content-Type: application/json' \
  -d '{"questionId":"target_type","answer":"信息抽取","customAnswer":""}'
```

生成最终提示词：

```bash
curl -s -X POST http://127.0.0.1:8080/api/orchestrator/sessions/<sessionId>/finalize \
  -H 'Content-Type: application/json' \
  -d '{"promptMode":"local"}'
```

查看知识库状态：

```bash
curl -s http://127.0.0.1:8080/api/knowledge/status
```

## 后续方向

当前版本已经具备：

- 前端工作台
- Python 后端编排
- LLM 接入
- 文件上传
- RAG 检索
- 同义词证据分级
- SQLite 持久化
- 自动评测

下一步建议优先做最终输出 schema 化：

1. 固定最终提示词结构。
2. 为抽取任务生成 JSON Schema。
3. 为同义词合并任务生成标准结果 schema。
4. 把 schema 字段纳入评测，避免最终提示词退化成松散自然语言。
