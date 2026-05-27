import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_json_config(filename, fallback):
    config_path = ROOT / "config" / filename
    try:
        return json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


FLOW_STEPS = [
    {"id": "role", "title": "角色与背景", "description": "确定业务身份与任务语境"},
    {"id": "target", "title": "抽取目标", "description": "确认本次要抽取的词条范围"},
    {"id": "synonym", "title": "术语确认", "description": "确认同义词与标准名称"},
    {"id": "format", "title": "输出格式", "description": "约束结构、证据与空值策略"},
    {"id": "finalize", "title": "最终修改", "description": "补充额外说明并生成提示词"},
]

WORKFLOW_DEFINITIONS = {
    "field_template": {"label": "抽取字段清单", "steps": FLOW_STEPS},
    "synonym_merge": {
        "label": "同义词合并规则",
        "steps": [
            {"id": "target", "title": "合并范围", "description": "确认要合并的术语集合与应用场景"},
            {"id": "synonym", "title": "术语证据", "description": "确认同义、别名、参见关系和不应合并项"},
            {"id": "format", "title": "合并规则", "description": "约束证据、置信度、标准名和输出格式"},
            {"id": "finalize", "title": "最终修改", "description": "补充边界条件并生成合并提示词"},
        ],
    },
    "prompt_generation": {
        "label": "生成可执行提示词",
        "steps": [
            {"id": "role", "title": "使用场景", "description": "确定模型角色与 prompt 用途"},
            {"id": "target", "title": "任务目标", "description": "确认待处理文档、任务边界和输入变量"},
            {"id": "synonym", "title": "术语确认", "description": "确认同义词、相关项和禁止合并边界"},
            {"id": "format", "title": "输出约束", "description": "确认输出结构、证据要求和失败策略"},
            {"id": "finalize", "title": "最终修改", "description": "补充措辞偏好并生成提示词"},
        ],
    },
}

GENERIC_LIBRARY = {
    "steel": {
        "label": "钢结构性能抽取",
        "roles": ["通用数据工程师", "材料数据抽取员", "标准审核人员", "研究助理"],
        "targets": ["性能词条", "构件类型", "连接方式", "病害与缺陷", "防护与加固措施"],
        "candidateTerms": ["强度", "刚度", "稳定性", "延性", "韧性", "耐火性", "耐久性", "抗震性", "抗腐蚀性", "疲劳性能", "屈服性能", "承载能力"],
        "constraints": ["保留原文证据句", "输出术语出现位置", "同义词合并去重", "给出字段置信度", "无法判断时输出 null", "保留中英文对照"],
        "outputFormats": ["JSON 数组", "Markdown 表格", "CSV 字段", "三元组列表"],
    },
    "corrosion": {
        "label": "腐蚀信息抽取",
        "roles": ["腐蚀数据工程师", "材料测试分析员", "标准审核人员", "研究助理"],
        "targets": ["腐蚀类型", "腐蚀产物", "环境因素", "试验条件", "评价指标"],
        "candidateTerms": ["点蚀", "缝隙腐蚀", "晶间腐蚀", "应力腐蚀", "腐蚀速率", "腐蚀电位", "失重", "温度", "氯离子浓度", "pH 值"],
        "constraints": ["区分现象与机理", "保留单位", "保留试验环境", "标注句级证据", "同义表达归并"],
        "outputFormats": ["JSON 对象", "Markdown 表格", "键值对清单", "知识图谱三元组"],
    },
    "general": {
        "label": "通用信息抽取",
        "roles": ["通用数据工程师", "业务分析师", "内容审核人员", "研究助理"],
        "targets": ["实体类型", "属性词条", "关系描述", "时间地点", "异常或结论"],
        "candidateTerms": ["材料组成", "工艺参数", "性能指标", "测试方法", "实验条件", "应用场景", "风险点", "结论性描述"],
        "constraints": ["保留原句", "区分事实与推测", "缺失项置空", "避免重复抽取", "保留章节标题"],
        "outputFormats": ["JSON 数组", "Markdown 表格", "层级清单", "问答式摘要"],
    },
}

SYNONYM_DICTIONARY = load_json_config("synonym_examples.json", {})

EVIDENCE_DECISION_MATRIX = {
    "excel_includes_parameter": {"grade": "A", "action": "自动合并", "relationType": "字段涵盖参数"},
    "dictionary_alias": {"grade": "A", "action": "自动合并", "relationType": "词典又称"},
    "dictionary_see_also": {"grade": "A", "action": "自动合并", "relationType": "词典见/参见"},
    "exact_alias": {"grade": "A", "action": "自动合并", "relationType": "精确别名"},
    "bilingual_alias": {"grade": "B", "action": "建议合并", "relationType": "中英文别名"},
    "abbreviation": {"grade": "B", "action": "建议合并", "relationType": "缩写/符号"},
    "llm_prior_alias": {"grade": "B", "action": "建议候选，需人工确认", "relationType": "LLM 领域知识候选"},
    "llm_prior_related": {"grade": "C", "action": "相关但不合并", "relationType": "LLM 相关术语候选"},
    "llm_prior_rejected": {"grade": "D", "action": "禁止合并", "relationType": "LLM 边界判断"},
    "related_only": {"grade": "C", "action": "相关但不合并", "relationType": "同类相关"},
    "field_type_conflict": {"grade": "D", "action": "禁止合并", "relationType": "字段类型冲突"},
    "metric_type_conflict": {"grade": "D", "action": "禁止合并", "relationType": "指标类型冲突"},
    "semantic_boundary_conflict": {"grade": "D", "action": "禁止合并", "relationType": "语义边界冲突"},
    "category_type_conflict": {"grade": "D", "action": "禁止合并", "relationType": "信息类别冲突"},
}

MERGE_POLICY_OPTIONS = [
    {
        "value": "严格合并",
        "label": "只合并明确同义",
        "description": "只有同义词、别名、缩写、符号或“又称/见/参见”证据充分时才合并；拿不准就不合并。",
    },
    {
        "value": "宽松聚类",
        "label": "先分组，保留关系",
        "description": "相近或同类术语可以放进同一候选组，但必须标明关系类型；不直接当作完全同义。",
    },
    {
        "value": "人工复核优先",
        "label": "不确定就交给人工确认",
        "description": "证据不足、边界模糊或可能混淆的术语进入待复核列表，模型不自动合并。",
    },
]


def workflow_definition(workflow):
    return WORKFLOW_DEFINITIONS.get(workflow) or WORKFLOW_DEFINITIONS["prompt_generation"]


def infer_scenario(prompt_text):
    text = (prompt_text or "").lower()
    if re.search(r"腐蚀|corrosion|点蚀|缝隙腐蚀|晶间腐蚀", text):
        return {"domainKey": "corrosion", "label": "腐蚀信息抽取", "confidence": 0.86}
    if re.search(r"钢|steel|强度|刚度|屈服|疲劳|结构|材料|alloy|glass|泡沫玻璃", text):
        return {"domainKey": "steel", "label": "材料/钢结构性能抽取", "confidence": 0.82}
    return {"domainKey": "general", "label": "通用信息抽取", "confidence": 0.55}


def split_alias_text(value):
    return [item.strip() for item in re.split(r"[、,，;；|/]", value or "") if item.strip()]


def clean_term(value):
    return re.sub(r"^[：:，,、\s]+|[：:，,、\s]+$", "", value or "").strip()


def extract_candidate_terms_from_prompt(prompt):
    text = str(prompt or "")
    stopwords = {
        "json",
        "markdown",
        "csv",
        "llm",
        "rag",
        "请把",
        "请做",
        "判断",
        "生成",
        "输出",
        "要求",
        "提示词",
        "同义词",
        "合并",
        "边界",
        "证据",
        "字段",
        "测试术语",
        "这些字段类型相近但不能互相合并",
    }
    terms = []
    latin_pattern = r"[A-Za-zα-ωΑ-ΩγδσΣ][A-Za-z0-9α-ωΑ-ΩγδσΣ.%′'_-]*(?:\s+[A-Za-z0-9α-ωΑ-ΩγδσΣ.%′'_-]+){0,4}"
    for match in re.finditer(latin_pattern, text):
        term = clean_term(match.group(0))
        lower = term.lower()
        if len(term) < 2 or lower in stopwords:
            continue
        if lower in {"json", "markdown", "csv"}:
            continue
        terms.append(term)
    for raw in re.split(r"[，,、；;。.!?？：:\n]|\s+和\s+|\s+与\s+|\s+及\s+", text):
        item = clean_term(raw)
        item = re.sub(r"^(?:请|把|将|判断|说明|生成|输出|保留|注意|例如|哪些|这些|这个|一个|用于|文档中|文中)+", "", item)
        item = re.sub(r"(?:是否)?(?:可以)?作为同义词合并.*$", "", item)
        item = re.sub(r"(的同义词项?|的合并边界|不能互相合并|不能合并|合并为同义词组)$", "", item)
        item = clean_term(item)
        if not item or item.lower() in stopwords:
            continue
        if re.search(r"确认合并|建议候选|不建议合并|合并理由|区分", item):
            continue
        if len(item) < 2 or len(item) > 36:
            continue
        if re.search(r"[\u4e00-\u9fffA-Za-zα-ωΑ-ΩγδσΣ]", item):
            terms.append(item)
    return list(dict.fromkeys(terms))[:20]


def evidence_decision(evidence_type):
    return EVIDENCE_DECISION_MATRIX.get(evidence_type) or {
        "grade": "B",
        "action": "建议合并",
        "relationType": "模型推断",
    }


def confidence_label(value):
    text = str(value or "").strip().lower()
    if text in ("high", "高", "高置信", "0.8", "0.9", "1"):
        return "高"
    if text in ("low", "低", "低置信", "0.3", "0.4"):
        return "低"
    if text in ("medium", "mid", "中", "中置信", "0.5", "0.6", "0.7"):
        return "中"
    return "中"


def synonym_bucket(group):
    grade = group.get("grade") or evidence_decision(group.get("evidenceType"))["grade"]
    if grade == "A":
        return "confirmed"
    if grade == "B":
        return "candidate"
    return "rejected"


def make_synonym_value(group):
    return f"{group.get('grade') or 'B'}|{group.get('canonical', '')} => {' / '.join(group.get('aliases') or [])}"


def make_synonym_description(group):
    decision = evidence_decision(group.get("evidenceType"))
    parts = [
        f"{group.get('grade') or decision['grade']} 级",
        f"证据类型：{group.get('evidenceType') or 'llm_inferred'}",
        f"决策：{decision['action']}",
        f"关系类型：{group.get('relationType') or decision['relationType']}",
    ]
    if group.get("evidenceText"):
        parts.append(f"证据：{group['evidenceText']}")
    if group.get("confidence"):
        parts.append(f"置信度：{confidence_label(group.get('confidence'))}")
    if group.get("reviewRequired"):
        parts.append("需要人工确认")
    return "；".join(parts)


def parse_knowledge_profile(text, scenario):
    library = GENERIC_LIBRARY[scenario["domainKey"]]
    terms = []
    synonyms = {}
    synonym_groups = []
    current_field = ""
    current_term = ""

    def add_group(canonical, aliases, evidence_type="llm_inferred", grade="", evidence_text="", disabled=False):
        canonical = clean_term(canonical)
        aliases = [clean_term(item) for item in aliases if clean_term(item)]
        aliases = [item for item in dict.fromkeys(aliases) if item != canonical]
        if not canonical or not aliases:
            return
        decision = evidence_decision(evidence_type)
        group = {
            "canonical": canonical,
            "aliases": aliases,
            "evidenceType": evidence_type,
            "grade": grade or decision["grade"],
            "relationType": decision["relationType"],
            "evidenceText": evidence_text,
            "autoSelect": decision["grade"] in ("A", "B") and not disabled,
            "disabled": disabled,
        }
        synonym_groups.append(group)
        terms.extend([canonical, *aliases])
        if group["grade"] in ("A", "B"):
            synonyms.setdefault(canonical, [])
            synonyms[canonical].extend(aliases)

    for raw_line in str(text or "").splitlines():
        line = raw_line.strip()
        line = re.sub(r"^[\s\-*+•·\d.、)）]+", "", line)
        line = re.sub(r"^(?:内容|text)[：:]\s*", "", line, flags=re.I).strip()
        if not line:
            continue
        match = re.search(r"^同义词组[：:]\s*(.+?)\s*=>\s*(.+?)(?:\s*（证据类型：(.+?)；证据等级：(.+?)；证据文本：(.+?)）)?$", line)
        if match:
            add_group(match.group(1), split_alias_text(match.group(2)), match.group(3) or "excel_includes_parameter", match.group(4) or "", match.group(5) or line)
            continue
        match = re.search(r"^(?:字段|列名)[：:]\s*(.+)$", line)
        if match:
            current_field = clean_term(match.group(1))
            terms.append(current_field)
            continue
        match = re.search(r"^涵盖参数[：:]\s*(.+)$", line)
        if match and current_field:
            add_group(current_field, split_alias_text(match.group(1)), "excel_includes_parameter", evidence_text=line)
            continue
        match = re.search(r"^术语[：:]\s*(.+)$", line)
        if match:
            current_term = clean_term(match.group(1))
            terms.append(current_term)
            continue
        match = re.search(r"^定义[：:]\s*又称(.+?)[。；;，,]", line)
        if match and current_term:
            add_group(current_term, split_alias_text(match.group(1)), "dictionary_alias", evidence_text=line)
            continue
        match = re.search(r"^定义[：:]\s*(?:见|参见)(.+?)(?:[（(]|[。；;，,]|$)", line)
        if match and current_term:
            add_group(clean_term(match.group(1)), [current_term], "dictionary_see_also", evidence_text=line)
            continue
        match = re.search(r"^(.{2,80}?)(?:又称|也称|亦称|别称|等价于|等同于|即)\s*([^。；;]{2,140})", line)
        if match:
            add_group(match.group(1), split_alias_text(match.group(2)), "dictionary_alias", evidence_text=line)
            continue
        match = re.search(r"^(.{2,80}?)(?:缩写为|简称|符号为|记作)\s*([^。；;，,]{2,80})", line)
        if match:
            add_group(match.group(1), split_alias_text(match.group(2)), "abbreviation", evidence_text=line)
            continue
        match = re.search(r"(.{2,80}?)(?:不能与|不应与|禁止与)\s*(.{2,80}?)(?:合并|归并)", line)
        if not match:
            match = re.search(r"(.{2,80}?)(?:不能|不应|禁止).{0,20}?(?:合并|归并).{0,20}?(.{2,80})", line)
        if match:
            add_group(match.group(1), [match.group(2)], "semantic_boundary_conflict", evidence_text=line, disabled=True)
            continue
        if "：" not in line and ":" not in line:
            fragments = split_alias_text(line)
            if len(fragments) > 1:
                terms.extend(fragments)
            elif 2 <= len(line) <= 36:
                terms.append(line)

    unique_terms = list(dict.fromkeys([term for term in terms if term]))
    return {
        "candidateTerms": unique_terms[:16] if len(unique_terms) >= 4 else library["candidateTerms"],
        "synonyms": synonyms,
        "synonymGroups": synonym_groups,
        "sourceLabel": "RAG 术语片段" if len(unique_terms) >= 4 else "RAG 片段不足，回退通用模板",
    }


def normalize_alias(value):
    return re.sub(r"[：:'\"“”‘’（）()[\]\s_\-]+", "", str(value or "").lower()).strip()


def field_conflict_options(terms):
    suffixes = ["name", "value", "unit", "ratio", "rate"]
    parsed = []
    for term in terms:
        lower = term.lower().strip()
        for suffix in suffixes:
            if lower.endswith(f" {suffix}"):
                parsed.append({"term": term, "base": term[: -len(suffix)].strip(), "suffix": suffix})
                break
    options = []
    seen = set()
    for i, left in enumerate(parsed):
        for right in parsed[i + 1 :]:
            if left["suffix"] == right["suffix"] or left["base"].lower() != right["base"].lower():
                continue
            key = "|".join(sorted([normalize_alias(left["term"]), normalize_alias(right["term"])]))
            if key in seen:
                continue
            seen.add(key)
            evidence_type = "metric_type_conflict" if {"ratio", "rate"} & {left["suffix"], right["suffix"]} else "field_type_conflict"
            group = {
                "canonical": left["term"],
                "aliases": [right["term"]],
                "evidenceType": evidence_type,
                "grade": "D",
                "evidenceText": "字段或指标类型不同，不能直接合并。",
                "disabled": True,
                "autoSelect": False,
            }
            options.append(
                {
                    "value": make_synonym_value(group),
                    "label": f"{left['term']}: {right['term']}",
                    "description": make_synonym_description(group),
                    "grade": "D",
                    "evidenceType": evidence_type,
                    "confidence": "high",
                    "bucket": "rejected",
                    "reviewRequired": False,
                    "autoSelect": False,
                    "disabled": True,
                }
            )
    return options


TERM_CONCEPT_PATTERNS = [
    ("material", [r"alloy|steel|glass|polymer|ceramic|composite|superalloy|foam glass|porous glass", r"材料|合金|钢|玻璃|陶瓷|复合材料|高温合金|泡沫玻璃|多孔玻璃|塑料"]),
    ("performance", [r"strength|hardness|ductility|toughness|elongation|fatigue|stiffness|performance|load-bearing|compressive|thermal conductivity", r"性能|强度|屈服|抗拉|抗压|导热系数|硬度|韧性|延性|伸长率|疲劳|刚度|承载"]),
    ("test_condition", [r"test condition|temperature|duration|pressure|environment|pre-strain|strain rate|charging|hydrogen concentration", r"试验条件|测试条件|温度|时间|压力|环境|预应变|应变速率|加载|充氢|氢浓度"]),
    ("measurement_result", [r"value|ratio|rate|loss|result|percentage|iuts|potential", r"数值|值|比例|速率|损失|结果|百分比|电位"]),
]

TERM_FAMILY_PATTERNS = [
    ("strength", "强度类性能", [r"strength|compressive", r"强度|屈服|抗拉|抗压"]),
    ("corrosion", "腐蚀类指标", [r"corrosion", r"腐蚀|点蚀|缝隙腐蚀"]),
    ("hydrogen", "氢脆/充氢相关", [r"hydrogen|embrittlement", r"氢|氢脆|充氢"]),
    ("strain", "应变相关", [r"strain", r"应变"]),
    ("temperature", "温度相关", [r"temperature", r"温度"]),
]


def matches_patterns(text, patterns):
    return any(re.search(pattern, text, re.I) for pattern in patterns)


def analyze_term(term):
    value = clean_term(term)
    concepts = set()
    families = set()
    for concept, patterns in TERM_CONCEPT_PATTERNS:
        if matches_patterns(value, patterns):
            concepts.add(concept)
    for family, _label, patterns in TERM_FAMILY_PATTERNS:
        if matches_patterns(value, patterns):
            families.add(family)
    if "material" in concepts and "test_condition" in concepts and not re.search(r"test|condition|测试|试验|pre-strain|strain rate|charging|hydrogen concentration|预应变|应变速率|充氢|氢浓度", value, re.I):
        concepts.discard("test_condition")
    metric_kind = ""
    if re.search(r"\bratio\b|percentage|iuts|损失率|比例|百分比", value, re.I):
        metric_kind = "ratio"
    elif re.search(r"\brate\b|速率", value, re.I):
        metric_kind = "rate"
    elif re.search(r"\bvalue\b|数值|值", value, re.I):
        metric_kind = "value"
    is_strength_loss = bool(re.search(r"strength loss|loss of strength|reduction in strength|percentage loss|iuts|强度损失", value, re.I))
    is_strength_metric = bool(re.search(r"strength|强度|屈服|抗拉|抗压", value, re.I)) and not is_strength_loss
    return {"term": value, "concepts": concepts, "families": families, "metricKind": metric_kind, "isStrengthLoss": is_strength_loss, "isStrengthMetric": is_strength_metric}


def shared_family(left, right):
    for family in left["families"]:
        if family in right["families"]:
            return next((label for item, label, _patterns in TERM_FAMILY_PATTERNS if item == family), family)
    return ""


def semantic_decision(left, right):
    if (left["isStrengthLoss"] and right["isStrengthMetric"]) or (right["isStrengthLoss"] and left["isStrengthMetric"]):
        return {"grade": "D", "evidenceType": "semantic_boundary_conflict", "evidenceText": "强度损失率描述强度下降比例或损失程度，强度值描述材料性能数值，二者不能合并。"}
    if left["metricKind"] and right["metricKind"] and left["metricKind"] != right["metricKind"]:
        return {"grade": "D", "evidenceType": "metric_type_conflict", "evidenceText": f"{left['metricKind']} 与 {right['metricKind']} 属于不同指标类型，不能直接合并。"}
    if "material" in left["concepts"] and "material" in right["concepts"]:
        left_text = left["term"]
        right_text = right["term"]
        if (re.search(r"plastic|polymer|塑料|聚合物", left_text, re.I) and re.search(r"glass|玻璃", right_text, re.I)) or (
            re.search(r"plastic|polymer|塑料|聚合物", right_text, re.I) and re.search(r"glass|玻璃", left_text, re.I)
        ):
            return {"grade": "D", "evidenceType": "category_type_conflict", "evidenceText": "玻璃类无机材料与塑料/聚合物材料属于不同材料类别，不能作为同义词合并。"}
    if ("material" in left["concepts"] and ({"performance", "measurement_result", "test_condition"} & right["concepts"])) or ("material" in right["concepts"] and ({"performance", "measurement_result", "test_condition"} & left["concepts"])):
        return {"grade": "D", "evidenceType": "category_type_conflict", "evidenceText": "材料名或材料类别与性能指标、测量结果或试验条件属于不同信息类型，不能合并为同义词。"}
    if ("test_condition" in left["concepts"] and ({"measurement_result", "performance"} & right["concepts"])) or ("test_condition" in right["concepts"] and ({"measurement_result", "performance"} & left["concepts"])):
        return {"grade": "D", "evidenceType": "category_type_conflict", "evidenceText": "试验条件描述实验输入或环境，测量结果/性能指标描述输出结果，不能合并。"}
    family = shared_family(left, right)
    if family:
        return {"grade": "C", "evidenceType": "related_only", "evidenceText": f"二者同属{family}，但缺少同义、别名或符号等价证据，只能标记为相关术语。"}
    return None


def existing_pair_keys(options):
    keys = set()
    for option in options:
        relation = str(option.get("value") or "").split("|", 1)[-1]
        if "=>" not in relation:
            continue
        canonical, aliases_text = [item.strip() for item in relation.split("=>", 1)]
        for alias in re.split(r"\s*/\s*", aliases_text):
            key = "|".join(sorted([normalize_alias(canonical), normalize_alias(alias)]))
            if key:
                keys.add(key)
    return keys


def semantic_decision_options(terms, existing_options=None):
    analyses = [analyze_term(term) for term in dict.fromkeys([term for term in terms if clean_term(term)])]
    options = []
    seen = existing_pair_keys(existing_options or [])
    for left_index, left in enumerate(analyses):
        for right in analyses[left_index + 1 :]:
            key = "|".join(sorted([normalize_alias(left["term"]), normalize_alias(right["term"])]))
            if not key or key in seen:
                continue
            decision = semantic_decision(left, right)
            if not decision:
                continue
            seen.add(key)
            group = {
                "canonical": left["term"],
                "aliases": [right["term"]],
                "evidenceType": decision["evidenceType"],
                "grade": decision["grade"],
                "evidenceText": decision["evidenceText"],
                "disabled": True,
                "autoSelect": False,
            }
            options.append(
                {
                    "value": make_synonym_value(group),
                    "label": f"{left['term']}: {right['term']}",
                    "description": make_synonym_description(group),
                    "grade": group["grade"],
                    "evidenceType": group["evidenceType"],
                    "confidence": "high",
                    "bucket": "rejected",
                    "reviewRequired": False,
                    "autoSelect": False,
                    "disabled": True,
                }
            )
    return options


def get_synonym_options(terms, knowledge_profile):
    selected_keys = {normalize_alias(term) for term in terms if normalize_alias(term)}
    used = set()
    options = []
    for group in (knowledge_profile or {}).get("synonymGroups") or []:
        members = [group.get("canonical", ""), *((group.get("aliases") or []))]
        member_keys = {normalize_alias(item) for item in members if normalize_alias(item)}
        if selected_keys and not member_keys.intersection(selected_keys):
            continue
        if group.get("grade") not in ("C", "D") and member_keys.intersection(used):
            continue
        if group.get("grade") not in ("C", "D"):
            used.update(member_keys)
        options.append(
            {
                "value": make_synonym_value(group),
                "label": f"{group.get('canonical')}: {' / '.join(group.get('aliases') or [])}",
                "description": make_synonym_description(group),
                "grade": group.get("grade"),
                "evidenceType": group.get("evidenceType"),
                "confidence": group.get("confidence") or "medium",
                "bucket": synonym_bucket(group),
                "reviewRequired": group.get("reviewRequired", group.get("grade") != "A"),
                "autoSelect": group.get("autoSelect", False),
                "disabled": group.get("disabled", False),
            }
        )
    for term in terms:
        key = normalize_alias(term)
        if not key or key in used:
            continue
        related = list(dict.fromkeys([*((knowledge_profile or {}).get("synonyms") or {}).get(term, []), *(SYNONYM_DICTIONARY.get(term) or [])]))
        related = [item for item in related if normalize_alias(item) and normalize_alias(item) != key]
        if not related:
            continue
        used.update([key, *[normalize_alias(item) for item in related]])
        group = {
            "canonical": term,
            "aliases": related,
            "evidenceType": "bilingual_alias",
            "grade": "B",
            "evidenceText": "内置通用术语词典",
            "autoSelect": False,
            "disabled": False,
        }
        options.append(
            {
                "value": make_synonym_value(group),
                "label": f"{term}: {' / '.join(related)}",
                "description": make_synonym_description(group),
                "grade": "B",
                "evidenceType": "bilingual_alias",
                "confidence": "medium",
                "bucket": "candidate",
                "reviewRequired": True,
                "autoSelect": False,
                "disabled": False,
            }
        )
    options.extend(field_conflict_options(terms))
    options.extend(semantic_decision_options(terms, options))
    return options


def option_list(items, description):
    return [{"value": item, "label": item, "description": description.format(item=item)} for item in items]


def empty_knowledge_profile(scenario):
    library = GENERIC_LIBRARY[scenario["domainKey"]]
    return {"candidateTerms": library["candidateTerms"], "synonyms": {}, "synonymGroups": [], "sourceLabel": "通用模板"}


def parse_llm_json(content):
    text = str(content or "").strip()
    text = re.sub(r"^```json\s*|^```\s*|```$", "", text, flags=re.I).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("LLM synonym expansion did not return a JSON object.")
    return json.loads(text[start : end + 1])


def normalize_llm_group(item, evidence_type, grade, review_required):
    if not isinstance(item, dict):
        return None
    canonical = clean_term(item.get("canonical") or item.get("standard") or item.get("name") or "")
    aliases = item.get("aliases")
    if aliases is None:
        aliases = item.get("terms") or item.get("related") or []
    if isinstance(aliases, str):
        aliases = split_alias_text(aliases)
    aliases = [clean_term(alias) for alias in aliases or [] if clean_term(alias)]
    aliases = [alias for alias in dict.fromkeys(aliases) if alias != canonical]
    if not canonical or not aliases:
        return None
    confidence = confidence_label(item.get("confidence"))
    reason = clean_term(item.get("reason") or item.get("evidence") or item.get("note") or "")
    group = {
        "canonical": canonical,
        "aliases": aliases[:10],
        "evidenceType": evidence_type,
        "grade": grade,
        "relationType": evidence_decision(evidence_type)["relationType"],
        "evidenceText": reason or "LLM 基于通用领域知识生成，未见文档证据。",
        "confidence": confidence,
        "reviewRequired": review_required,
        "autoSelect": False,
        "disabled": grade in ("C", "D"),
    }
    return group


def normalize_llm_synonym_expansion(payload):
    groups = []
    for item in payload.get("confirmed") or payload.get("exact_aliases") or []:
        group = normalize_llm_group(item, "llm_prior_alias", "B", True)
        if group:
            groups.append(group)
    for item in payload.get("candidates") or payload.get("related_candidates") or []:
        group = normalize_llm_group(item, "llm_prior_related", "C", True)
        if group:
            groups.append(group)
    for item in payload.get("rejected") or payload.get("do_not_merge") or []:
        group = normalize_llm_group(item, "llm_prior_rejected", "D", False)
        if group:
            groups.append(group)
    return groups


def merge_llm_synonym_groups(knowledge_profile, llm_groups):
    profile = knowledge_profile or {"candidateTerms": [], "synonyms": {}, "synonymGroups": [], "sourceLabel": "通用模板"}
    existing_keys = {
        "|".join(sorted([normalize_alias(group.get("canonical")), normalize_alias(alias)]))
        for group in profile.get("synonymGroups") or []
        for alias in group.get("aliases") or []
    }
    merged_groups = list(profile.get("synonymGroups") or [])
    candidate_terms = list(profile.get("candidateTerms") or [])
    for group in llm_groups:
        aliases_to_add = []
        for alias in group.get("aliases") or []:
            key = "|".join(sorted([normalize_alias(group.get("canonical")), normalize_alias(alias)]))
            if not key or key in existing_keys:
                continue
            existing_keys.add(key)
            aliases_to_add.append(alias)
        if not aliases_to_add:
            continue
        merged = {**group, "aliases": aliases_to_add}
        merged_groups.append(merged)
        candidate_terms.extend([merged["canonical"], *aliases_to_add])
    profile["synonymGroups"] = merged_groups
    profile["candidateTerms"] = list(dict.fromkeys([term for term in candidate_terms if term]))[:20]
    profile["sourceLabel"] = f"{profile.get('sourceLabel') or '通用模板'} + LLM 候选"
    return profile


def build_questions(source_mode, scenario, knowledge_profile, workflow, prompt_text=""):
    library = GENERIC_LIBRARY[scenario["domainKey"]]
    prompt_terms = extract_candidate_terms_from_prompt(prompt_text)
    candidate_terms = (knowledge_profile or {}).get("candidateTerms")
    candidate_terms = list(dict.fromkeys([*prompt_terms, *(candidate_terms or []), *library["candidateTerms"]]))[:20]
    if workflow == "synonym_merge":
        return [
            {"id": "target_type", "stepId": "target", "type": "single", "category": "合并范围", "title": "这次同义词合并主要服务于哪类结果？", "description": "不同用途会影响标准名选择、合并边界和证据要求。", "options": option_list(["抽取字段标准化", "材料术语归一", "中英文别名合并", "标准/规范术语对齐"], "以{item}为主要合并目标。"), "required": True},
            {"id": "candidate_terms", "stepId": "target", "type": "multi", "category": "合并范围", "title": "请选择需要进入合并判断的术语", "description": "候选项来自原始需求、知识库或通用模板，可手动补充。", "options": option_list(candidate_terms, "纳入本轮同义词/别名合并判断。"), "required": True},
            {"id": "bilingual_synonym", "stepId": "synonym", "type": "boolean", "category": "术语证据", "title": "是否把中英文、缩写和符号视为可合并候选？", "description": "例如 yield strength、YS、σ0.2、Rp0.2 这类表达。", "options": [{"value": "yes", "label": "是", "description": "纳入中英文、缩写和符号别名。"}, {"value": "no", "label": "否", "description": "只处理同语言内的近义或别名。"}], "required": True},
            {"id": "synonym_groups", "stepId": "synonym", "type": "multi", "category": "术语证据", "title": "请确认可合并的同义词组", "description": "优先展示知识证据形成的候选组。", "options": [], "required": False},
            {"id": "merge_policy", "stepId": "format", "type": "single", "category": "合并规则", "title": "遇到相近但不完全等价的概念时怎么处理？", "description": "选择模型遇到相近术语时的风险偏好。", "options": MERGE_POLICY_OPTIONS, "required": True},
            {"id": "output_format", "stepId": "format", "type": "single", "category": "合并规则", "title": "同义词合并结果用什么格式输出？", "description": "建议输出可审计的标准名、别名、证据和置信度。", "options": option_list(["JSON 数组", "Markdown 表格", "标准名-别名映射表", "待复核清单"], "按照{item}输出合并结果。"), "required": True},
            {"id": "constraints", "stepId": "format", "type": "multi", "category": "合并规则", "title": "合并时必须保留哪些审计信息？", "description": "这些信息会帮助用户判断候选组是否可信。", "options": option_list(["知识来源", "证据原文", "关系类型", "置信度", "不合并原因", "人工复核标记"], "保留{item}。"), "required": False},
            {"id": "extra_instructions", "stepId": "finalize", "type": "text", "category": "最终修改", "title": "还有哪些合并边界需要说明？", "description": "例如哪些术语不能合并、标准名优先级、单位差异处理方式。", "placeholder": "例如：强度值和强度损失率不能合并。", "required": False},
        ]
    return [
        {"id": "business_role", "stepId": "role", "type": "single", "category": "角色与背景", "title": "当前业务角色更接近哪一种？", "description": "确定提示词的专业语气与任务上下文。", "options": option_list(library["roles"], "后续问题会按 {item} 的工作方式组织。"), "required": True},
        {"id": "target_type", "stepId": "target", "type": "single", "category": "抽取目标", "title": "你希望系统聚焦抽取哪一类内容？", "description": "决定候选项与最终提示词的任务边界。", "options": option_list(["信息抽取", "同义词合并", "术语标准化", *library["targets"]], "将 {item} 作为本次主目标。"), "required": True},
        {"id": "candidate_terms", "stepId": "target", "type": "multi", "category": "抽取目标", "title": "请选择你希望纳入的候选词条", "description": "候选词来自知识库或通用模板。", "options": option_list(candidate_terms, "写入提示词中的候选术语集合。"), "required": True},
        {"id": "bilingual_synonym", "stepId": "synonym", "type": "boolean", "category": "术语确认", "title": "是否要求英文术语附带中文翻译，并进行同义词归并？", "description": "适用于术语标准化、别名合并与中英文结果对齐。", "options": [{"value": "yes", "label": "是", "description": "强制中英文归并。"}, {"value": "no", "label": "否", "description": "保留原术语。"}], "required": True},
        {"id": "synonym_groups", "stepId": "synonym", "type": "multi", "category": "术语确认", "title": "请确认以下属性的同义词或同类表达", "description": "系统会根据候选词生成待确认同义词组。", "options": [], "required": False},
        {"id": "merge_policy", "stepId": "synonym", "type": "single", "category": "术语确认", "title": "遇到相近术语时，模型应该多保守？", "description": "选择模型在“可能相关但不完全等价”时的处理方式。", "options": MERGE_POLICY_OPTIONS, "required": True},
        {"id": "output_format", "stepId": "format", "type": "single", "category": "输出格式", "title": "你希望输出格式是什么？", "description": "最终提示词会明确指定模型输出结构。", "options": option_list(library["outputFormats"], "要求模型按照 {item} 输出。"), "required": True},
        {"id": "constraints", "stepId": "format", "type": "multi", "category": "输出格式", "title": "你还希望加入哪些约束？", "description": "这些约束会体现在最终提示词细节里。", "options": option_list(list(dict.fromkeys([*library["constraints"], "证据原文", "输出前自检", "不合并原因"])), "加入约束：{item}。"), "required": False},
        {"id": "extra_instructions", "stepId": "finalize", "type": "text", "category": "最终修改", "title": "还有没有额外说明？", "description": "例如字段命名规则、输出语言、是否允许空值等。", "placeholder": "例如：字段名统一用中文；若没有证据句则不要臆造。", "required": False},
    ]


def parse_custom_items(value):
    return [item.strip() for item in re.split(r"[\n,，;；、|]", str(value or "")) if item.strip()]


def default_answers(questions):
    answers = {}
    for question in questions:
        if question["type"] == "multi":
            answers[question["id"]] = []
        elif question["type"] == "boolean":
            answers[question["id"]] = "yes"
        else:
            answers[question["id"]] = ""
    return answers


def default_custom_answers(questions):
    return {question["id"]: "" for question in questions if question["type"] != "text"}


def option_value(question, label):
    for option in question.get("options") or []:
        if option.get("value") == label or option.get("label") == label:
            return option.get("value")
    return ""


def infer_auto_answers(prompt, workflow, questions):
    text = re.sub(r"\s+", " ", str(prompt or "").lower())
    by_id = {question["id"]: question for question in questions}
    auto = {}

    def set_answer(question_id, answer, reason):
        if answer not in ("", None, []):
            auto[question_id] = {"answer": answer, "reason": reason}

    target = by_id.get("target_type")
    if target:
        if workflow == "synonym_merge":
            if re.search(r"材料|material|alloy|glass|泡沫玻璃|术语归一", text):
                set_answer("target_type", option_value(target, "材料术语归一"), "原始需求已指向材料术语归一。")
            elif re.search(r"字段|field|column", text):
                set_answer("target_type", option_value(target, "抽取字段标准化"), "原始需求已指向字段标准化。")
            elif re.search(r"标准|规范|standard", text):
                set_answer("target_type", option_value(target, "标准/规范术语对齐"), "原始需求已指向标准术语对齐。")
        elif re.search(r"抽取|extract|提取|信息抽取", text):
            set_answer("target_type", option_value(target, "信息抽取") or option_value(target, "性能词条"), "原始需求已明确是抽取任务。")
        elif re.search(r"同义词|合并|归一|标准化", text):
            set_answer("target_type", option_value(target, "同义词合并") or option_value(target, "术语标准化"), "原始需求已明确是术语合并/标准化任务。")

    output = by_id.get("output_format")
    if output:
        if re.search(r"json\s*数组|json array", text):
            set_answer("output_format", option_value(output, "JSON 数组"), "原始需求已指定 JSON 数组。")
        elif re.search(r"markdown\s*表格|markdown table", text):
            set_answer("output_format", option_value(output, "Markdown 表格"), "原始需求已指定 Markdown 表格。")
        elif re.search(r"\bcsv\b", text):
            set_answer("output_format", option_value(output, "CSV 字段"), "原始需求已指定 CSV。")

    bilingual = by_id.get("bilingual_synonym")
    if bilingual:
        if re.search(r"不需要.*(同义|归并|合并)|无需.*(同义|归并|合并)", text):
            set_answer("bilingual_synonym", "no", "原始需求明确不需要同义词归并。")
        elif re.search(r"同义词|别名|中英文|英文|缩写|符号|归并|合并|alias|abbreviation", text):
            set_answer("bilingual_synonym", "yes", "原始需求已要求同义词/别名处理。")

    merge_policy = by_id.get("merge_policy")
    if merge_policy:
        if re.search(r"严格|只有明确|不得.*推断|不能.*推断", text):
            set_answer("merge_policy", option_value(merge_policy, "严格合并"), "原始需求已要求严格合并。")
        elif re.search(r"人工复核|待确认|复核", text):
            set_answer("merge_policy", option_value(merge_policy, "人工复核优先"), "原始需求已要求人工复核。")

    constraints = by_id.get("constraints")
    if constraints:
        requested = []
        for option in constraints.get("options") or []:
            value = option.get("value", "")
            if value.lower() in text:
                requested.append(value)
            elif value == "证据原文" and re.search(r"证据句|原文证据|证据原文", text):
                requested.append(value)
            elif value == "输出前自检" and re.search(r"自检|检查", text):
                requested.append(value)
            elif value == "不合并原因" and re.search(r"不合并原因|不能合并|禁止合并", text):
                requested.append(value)
        if len(requested) >= 1:
            set_answer("constraints", list(dict.fromkeys(requested)), "原始需求已明确执行约束。")
    return auto


def get_answer(session, question_id, question_type):
    answer = (session.get("answers") or {}).get(question_id)
    custom_items = parse_custom_items((session.get("customAnswers") or {}).get(question_id))
    if question_type == "multi":
        base = answer if isinstance(answer, list) else []
        return list(dict.fromkeys([*base, *custom_items]))
    if question_type == "text":
        return answer or ""
    if answer == "__custom__":
        return "；".join(custom_items)
    return answer or "；".join(custom_items)


def refresh_synonym_question(session):
    question = next((item for item in session["questions"] if item["id"] == "synonym_groups"), None)
    if not question:
        return
    selected = get_answer(session, "candidate_terms", "multi")
    fallback = GENERIC_LIBRARY[session["scenario"]["domainKey"]]["candidateTerms"][:3]
    question["options"] = get_synonym_options(selected or fallback, session.get("knowledgeProfile"))
    if not session["answers"].get("synonym_groups"):
        session["answers"]["synonym_groups"] = [option["value"] for option in question["options"] if option.get("autoSelect") and not option.get("disabled")]


def should_skip_question(session, question):
    if not question:
        return False
    if question["id"] in (session.get("autoAnswers") or {}):
        return True
    if question["id"] == "synonym_groups":
        refresh_synonym_question(session)
        return get_answer(session, "bilingual_synonym", "boolean") == "no" or not question.get("options")
    return False


def move_to_first_unskipped(session):
    session["currentIndex"] = 0
    while session["currentIndex"] < len(session["questions"]) - 1 and should_skip_question(session, session["questions"][session["currentIndex"]]):
        session["currentIndex"] += 1


def advance(session):
    while session["currentIndex"] < len(session["questions"]) - 1:
        session["currentIndex"] += 1
        if not should_skip_question(session, session["questions"][session["currentIndex"]]):
            return


def previous(session):
    while session["currentIndex"] > 0:
        session["currentIndex"] -= 1
        if not should_skip_question(session, session["questions"][session["currentIndex"]]):
            return


def current_question(session):
    refresh_synonym_question(session)
    return session["questions"][session["currentIndex"]] if session.get("questions") else None


def synonym_evidence_summary(session):
    selected = get_answer(session, "synonym_groups", "multi")
    question = next((item for item in session["questions"] if item["id"] == "synonym_groups"), None)
    options = question.get("options") if question else []
    option_map = {option["value"]: option for option in options}
    selected_options = []
    for item in selected:
        text = str(item)
        matched = option_map.get(text)
        if not matched:
            matched = next(
                (
                    option
                    for option in options
                    if not option.get("disabled")
                    and (
                        str(option.get("value") or "").startswith(f"A|{text} =>")
                        or str(option.get("value") or "").startswith(f"B|{text} =>")
                        or str(option.get("label") or "").startswith(f"{text}:")
                    )
                ),
                None,
            )
        selected_options.append(matched or {"value": item, "description": ""})
    related = [option for option in options if option.get("grade") == "C"]
    forbidden = [option for option in options if option.get("grade") == "D"]

    def section(title, items):
        if not items:
            return f"{title}\n- 无"
        return "\n".join([title, *[f"- {item.get('value') or item.get('label')}；{item.get('description', '')}" for item in items]])

    return "\n".join([section("自动/确认合并项：", selected_options), section("相关但不合并项：", related), section("禁止合并项：", forbidden)])


def build_prompt_text(session):
    selected_terms = get_answer(session, "candidate_terms", "multi")
    output_format = get_answer(session, "output_format", "single") or "待确认"
    bilingual = get_answer(session, "bilingual_synonym", "boolean")
    constraints = "；".join(get_answer(session, "constraints", "multi")) or "无额外约束"
    merge_policy = get_answer(session, "merge_policy", "single") or "未指定"
    synonyms = synonym_evidence_summary(session) if bilingual == "yes" else "不强制做同义词归并"
    refinements = session.get("refinements") or []
    refinement_block = "\n\n继续追问修改：\n" + "\n".join([f"{index + 1}. {item}" for index, item in enumerate(refinements)]) if refinements else ""
    if session["workflow"] == "synonym_merge":
        return f"""你是材料术语标准化与同义词合并助手，请根据以下要求生成可审计的同义词合并结果。

原始需求参考：
{session.get('prompt') or '待输入'}

合并目标：
{get_answer(session, 'target_type', 'single') or '待确认'}

待判断术语：
{'、'.join(selected_terms) if selected_terms else '待用户补充'}

同义词确认结果：
{synonyms}

合并策略：
{merge_policy}

输出格式：
{output_format}

审计约束：
{constraints}

补充说明：
{get_answer(session, 'extra_instructions', 'text') or '无'}

知识证据：
{session.get('knowledge') if session.get('sourceMode') == 'rag' else '基于通用领域模板组织候选。'}

执行规则：
1. 可以利用已有领域知识提出候选同义词，但没有文档或词典证据时只能标记为“建议候选/待确认”，不能直接作为最终合并。
2. 只有明确证据的同义词、别名、英文缩写、符号表达、又称、见/参见关系才能自动合并。
3. 相近但不完全等价的概念必须标记为“相关但不合并”或“待复核”，不能直接并入标准名。
4. 每个合并组输出标准名、别名列表、关系类型、证据来源、证据原文、置信度、是否需要人工复核。
5. 结果必须分为“确认合并”“建议候选”“不建议合并”三类，并明确“不应合并”的边界和原因。
6. 按“{output_format}”输出。{refinement_block}"""
    return f"""你是{get_answer(session, 'business_role', 'single') or '专业信息抽取助手'}，请根据以下要求从用户提供的文档中执行信息抽取。

原始需求参考：
{session.get('prompt') or '待输入'}

任务场景：
{session.get('scenario', {}).get('label', '待识别')}

抽取目标：
{get_answer(session, 'target_type', 'single') or '待确认'}

重点候选词条：
{'、'.join(selected_terms) if selected_terms else '待用户补充'}

输出格式要求：
{output_format}

术语标准化要求：
{'需要英文附中文翻译，并合并同义词。' if bilingual == 'yes' else '无需强制中英对照。'}

术语合并策略：
{merge_policy}

同义词确认结果：
{synonyms}

输出与质量约束：
{constraints}

补充说明：
{get_answer(session, 'extra_instructions', 'text') or '无'}

候选项来源：
{('优先参考附带术语片段：' + (session.get('knowledge') or '未提供详细术语片段。')) if session.get('sourceMode') == 'rag' else '基于通用领域模板组织问答与候选词。'}

执行规则：
1. 仅基于待处理文档内容抽取，不要臆造文中没有的信息。
2. 可以利用已有领域知识提出同义词候选，但缺少文档证据时必须标记为“建议候选/待确认”，不能直接合并。
3. 先识别同义词、近义词、英文缩写和等价表达，再按证据强度归并到标准词条。
4. 若出现英文术语，必须在同一字段中附带中文翻译。
5. 每条结果尽量保留原文证据句；无法判断时按约束输出空值或 null。
6. 同义词处理必须区分“确认合并”“建议候选”“不建议合并”，并给出置信度与人工复核标记。
7. 按“{output_format}”输出，字段至少包含：标准词条、原文表述、同义/英文表达、证据句、备注。
8. 输出前检查去重、字段完整性和格式合法性。{refinement_block}"""


def serialize_session(session):
    return {
        "id": session["id"],
        "prompt": session["prompt"],
        "workflow": session["workflow"],
        "workflowLabel": workflow_definition(session["workflow"])["label"],
        "sourceMode": session["sourceMode"],
        "model": session["model"],
        "knowledge": session.get("knowledge", ""),
        "scenario": session.get("scenario"),
        "knowledgeProfile": session.get("knowledgeProfile"),
        "llmSynonymExpansion": session.get("llmSynonymExpansion"),
        "questionSource": session.get("questionSource"),
        "promptSource": session.get("promptSource"),
        "currentIndex": session.get("currentIndex", 0),
        "currentQuestion": current_question(session),
        "isComplete": session.get("currentIndex", 0) >= len(session.get("questions", [])) - 1 and bool(session.get("finalPrompt")),
        "questions": session.get("questions", []),
        "answers": session.get("answers", {}),
        "customAnswers": session.get("customAnswers", {}),
        "autoAnswers": session.get("autoAnswers", {}),
        "refinements": session.get("refinements", []),
        "finalPrompt": session.get("finalPrompt", ""),
        "createdAt": session.get("createdAt"),
        "updatedAt": session.get("updatedAt"),
    }


class Orchestrator:
    def __init__(self, call_llm=None, default_model="gpt-4.1", storage=None):
        self.call_llm = call_llm
        self.default_model = default_model
        self.storage = storage
        self.sessions = {}

    def persist(self, session, event_type, detail=None):
        serialized = serialize_session(session)
        if self.storage:
            self.storage.save_session(serialized)
            self.storage.append_audit(
                {
                    "type": event_type,
                    "sessionId": session["id"],
                    "detail": detail or {},
                }
            )
        return serialized

    def require_session(self, session_id):
        if session_id in self.sessions:
            return self.sessions[session_id]
        if self.storage:
            loaded = self.storage.load_session(session_id)
            if loaded:
                self.sessions[session_id] = loaded
                return loaded
        raise KeyError("session not found.")

    def expand_synonyms_with_llm(self, prompt, scenario, knowledge_profile, model=""):
        if not self.call_llm:
            return {"groups": [], "error": ""}
        candidate_terms = (knowledge_profile or {}).get("candidateTerms") or GENERIC_LIBRARY[scenario["domainKey"]]["candidateTerms"]
        knowledge = str((knowledge_profile or {}).get("sourceLabel") or "")
        messages = [
            {
                "role": "system",
                "content": (
                    "你是严谨的术语标准化助手。你可以使用自己的领域知识提出同义词和相关词候选，"
                    "但不能把缺少证据的相关概念当作最终同义词。只返回 JSON。"
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "task": prompt,
                        "scenario": scenario,
                        "candidate_terms": candidate_terms[:20],
                        "knowledge_source": knowledge,
                        "return_schema": {
                            "confirmed": [
                                {
                                    "canonical": "标准名",
                                    "aliases": ["同义词、英文翻译、缩写或符号"],
                                    "confidence": "high|medium|low",
                                    "reason": "为什么只是候选，或有什么常识依据",
                                }
                            ],
                            "candidates": [
                                {
                                    "canonical": "中心词",
                                    "aliases": ["相关但不完全等价的术语"],
                                    "confidence": "high|medium|low",
                                    "reason": "为什么不能自动合并",
                                }
                            ],
                            "rejected": [
                                {
                                    "canonical": "中心词",
                                    "aliases": ["不应合并的术语"],
                                    "confidence": "high|medium|low",
                                    "reason": "不合并边界",
                                }
                            ],
                        },
                        "rules": [
                            "confirmed 也只能作为建议候选，前端需要人工确认后才进入最终合并。",
                            "上下游概念、现象、机理、测试条件、数值字段、单位字段不得直接合并。",
                            "中英文翻译、缩写、符号写法可以进入 confirmed，但 reason 必须说明依据。",
                            "最多返回 8 组 confirmed、8 组 candidates、8 组 rejected。",
                        ],
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        result = self.call_llm(model=model or self.default_model, messages=messages, temperature=0.1, json_mode=True)
        content = result.get("content") if isinstance(result, dict) else result
        payload = parse_llm_json(content)
        return {"groups": normalize_llm_synonym_expansion(payload), "error": ""}

    def build_llm_final_prompt(self, session, model=""):
        if not self.call_llm:
            raise RuntimeError("LLM backend is not configured.")
        draft = build_prompt_text(session)
        messages = [
            {
                "role": "system",
                "content": (
                    "你是提示词工程师。请把输入草稿改写成可直接执行的最终提示词。"
                    "保留术语合并证据、LLM 候选限制、RAG 证据要求、null 策略和人工复核规则。"
                    "不要输出寒暄。"
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "raw_task": session.get("prompt"),
                        "workflow": session.get("workflow"),
                        "answers": session.get("answers"),
                        "custom_answers": session.get("customAnswers"),
                        "knowledge": session.get("knowledge"),
                        "knowledge_profile": session.get("knowledgeProfile"),
                        "local_draft": draft,
                        "requirements": [
                            "LLM 可以使用已有领域知识提出候选同义词，但不得直接确认最终合并。",
                            "最终合并必须区分：确认合并、建议候选、不建议合并。",
                            "缺少文档证据时标记待确认。",
                            "每个同义词组输出标准名、别名、关系类型、证据、置信度、人工复核标记。",
                        ],
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        result = self.call_llm(model=model or session.get("model") or self.default_model, messages=messages, temperature=0.2)
        content = result.get("content") if isinstance(result, dict) else result
        return str(content or "").strip() or draft

    def create_session(self, input_data):
        prompt = str(input_data.get("prompt") or "").strip()
        if not prompt:
            raise ValueError("prompt is required.")
        source_mode = "rag" if input_data.get("sourceMode") == "rag" else "generic"
        workflow = input_data.get("workflow") if input_data.get("workflow") in WORKFLOW_DEFINITIONS else "prompt_generation"
        model = input_data.get("model") or self.default_model
        knowledge = str(input_data.get("knowledge") or "").strip()
        scenario = infer_scenario(prompt)
        knowledge_profile = parse_knowledge_profile(knowledge, scenario) if source_mode == "rag" else None
        llm_synonym_expansion = {"enabled": input_data.get("questionMode") == "llm", "groups": [], "error": ""}
        if input_data.get("questionMode") == "llm" and self.call_llm:
            try:
                base_profile = knowledge_profile or empty_knowledge_profile(scenario)
                llm_synonym_expansion = self.expand_synonyms_with_llm(prompt, scenario, base_profile, model)
                if llm_synonym_expansion.get("groups"):
                    knowledge_profile = merge_llm_synonym_groups(base_profile, llm_synonym_expansion["groups"])
            except Exception as error:
                llm_synonym_expansion = {"enabled": True, "groups": [], "error": str(error)}
        questions = build_questions(source_mode, scenario, knowledge_profile, workflow, prompt)
        auto_answers = infer_auto_answers(prompt, workflow, questions)
        answers = default_answers(questions)
        for question_id, item in auto_answers.items():
            answers[question_id] = item["answer"]
        timestamp = now_iso()
        session = {
            "id": str(uuid.uuid4()),
            "prompt": prompt,
            "workflow": workflow,
            "sourceMode": source_mode,
            "model": model,
            "knowledge": knowledge,
            "scenario": scenario,
            "knowledgeProfile": knowledge_profile,
            "llmSynonymExpansion": llm_synonym_expansion,
            "questions": questions,
            "answers": answers,
            "customAnswers": default_custom_answers(questions),
            "autoAnswers": auto_answers,
            "currentIndex": 0,
            "refinements": [],
            "finalPrompt": "",
            "questionSource": {
                "type": "Python + LLM 候选" if llm_synonym_expansion.get("groups") else "Python 本地模板",
                "detail": (
                    f"LLM 生成 {len(llm_synonym_expansion.get('groups') or [])} 组同义词候选"
                    if llm_synonym_expansion.get("groups")
                    else f"LLM 候选不可用，已回退本地模板：{llm_synonym_expansion.get('error')}"
                    if llm_synonym_expansion.get("error")
                    else "backend/orchestrator.py"
                ),
            },
            "promptSource": {"type": "Python 本地模板", "detail": "实时预览"},
            "createdAt": timestamp,
            "updatedAt": timestamp,
        }
        move_to_first_unskipped(session)
        self.sessions[session["id"]] = session
        return self.persist(session, "create_session", {"questionCount": len(questions)})

    def get_session(self, session_id):
        return serialize_session(self.require_session(session_id))

    def list_sessions(self):
        if self.storage:
            return self.storage.list_sessions()
        return [serialize_session(item) for item in self.sessions.values()]

    def list_prompt_versions(self, session_id):
        return self.storage.list_prompt_versions(session_id) if self.storage else []

    def submit_answer(self, session_id, input_data):
        session = self.require_session(session_id)
        question = current_question(session)
        question_id = input_data.get("questionId") or (question or {}).get("id")
        if not question or question["id"] != question_id:
            raise RuntimeError("questionId does not match current question.")
        session["answers"][question["id"]] = input_data.get("answer", session["answers"].get(question["id"]))
        if question["type"] != "text":
            session["customAnswers"][question["id"]] = input_data.get("customAnswer") or ""
        if question["type"] == "multi":
            session["answers"][question["id"]] = get_answer(session, question["id"], "multi")
        advance(session)
        session["promptSource"] = {"type": "Python 本地模板", "detail": "实时预览"}
        session["finalPrompt"] = ""
        session["updatedAt"] = now_iso()
        return self.persist(session, "submit_answer", {"questionId": question["id"]})

    def navigate_session(self, session_id, input_data):
        session = self.require_session(session_id)
        if input_data.get("direction") == "previous":
            previous(session)
        elif input_data.get("direction") == "next":
            advance(session)
        elif isinstance(input_data.get("currentIndex"), int):
            session["currentIndex"] = max(0, min(input_data["currentIndex"], len(session["questions"]) - 1))
            if should_skip_question(session, session["questions"][session["currentIndex"]]):
                advance(session)
        else:
            raise ValueError("direction or currentIndex is required.")
        session["finalPrompt"] = ""
        session["promptSource"] = {"type": "Python 本地模板", "detail": "实时预览"}
        session["updatedAt"] = now_iso()
        return self.persist(session, "navigate_session", {"currentIndex": session["currentIndex"]})

    def finalize_session(self, session_id, input_data=None):
        input_data = input_data or {}
        session = self.require_session(session_id)
        refinement = str(input_data.get("refinement") or "").strip()
        if refinement:
            session["refinements"].append(refinement)
        prompt_mode = input_data.get("promptMode") or "local"
        if prompt_mode == "llm":
            session["finalPrompt"] = self.build_llm_final_prompt(session, input_data.get("model") or session.get("model"))
            session["promptSource"] = {"type": "Python + LLM 归纳", "detail": input_data.get("model") or session.get("model") or self.default_model}
        else:
            session["finalPrompt"] = build_prompt_text(session)
            session["promptSource"] = {"type": "Python 本地模板", "detail": "后端规则归纳"}
        session["updatedAt"] = now_iso()
        serialized = self.persist(session, "finalize_session", {"promptMode": prompt_mode})
        if self.storage:
            self.storage.append_prompt_version(
                {
                    "sessionId": session["id"],
                    "versionId": str(uuid.uuid4()),
                    "workflow": session["workflow"],
                    "sourceMode": session["sourceMode"],
                    "promptMode": prompt_mode,
                    "promptSource": session["promptSource"],
                    "prompt": session["prompt"],
                    "knowledge": session.get("knowledge", ""),
                    "knowledgeProfile": session.get("knowledgeProfile"),
                    "answers": session.get("answers", {}),
                    "customAnswers": session.get("customAnswers", {}),
                    "autoAnswers": session.get("autoAnswers", {}),
                    "refinements": session.get("refinements", []),
                    "finalPrompt": session.get("finalPrompt", ""),
                    "createdAt": session["updatedAt"],
                }
            )
        return serialized


def create_orchestrator(call_llm=None, default_model="gpt-4.1", storage=None):
    return Orchestrator(call_llm=call_llm, default_model=default_model, storage=storage)
