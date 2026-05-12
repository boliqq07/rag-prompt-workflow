#!/usr/bin/env python3
"""Search a Milvus knowledge collection created by ingest_knowledge.py."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import warnings
from pathlib import Path

from ingest_knowledge import DEFAULT_COLLECTION, DEFAULT_DB_PATH, embed_texts, load_env_file


ROOT = Path(__file__).resolve().parents[1]
warnings.filterwarnings("ignore", message="pkg_resources is deprecated as an API.*", category=UserWarning)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Search the local Milvus knowledge collection.")
    parser.add_argument("query", help="Search query text.")
    parser.add_argument("--db-path", default=os.environ.get("MILVUS_DB_PATH", DEFAULT_DB_PATH))
    parser.add_argument("--collection", default=os.environ.get("MILVUS_COLLECTION", DEFAULT_COLLECTION))
    parser.add_argument("--embedding-mode", choices=["hash", "openai"], default=os.environ.get("EMBEDDING_MODE", "hash"))
    parser.add_argument("--embedding-dim", type=int, default=int(os.environ.get("EMBEDDING_DIM", "384")))
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--candidate-limit", type=int, default=0, help="Number of vector hits to rerank before truncating.")
    parser.add_argument("--min-score", type=float, default=float(os.environ.get("KNOWLEDGE_MIN_SCORE", "0.3")))
    return parser.parse_args(argv)


def query_phrases(query: str) -> list[str]:
    phrases: set[str] = set()
    lowered = query.lower()
    for part in re.split(r"[\s,，/;；]+", query):
        part = part.strip()
        if len(part) >= 2:
            phrases.add(part)
    if "gamma prime" in lowered or "γ prime" in lowered:
        phrases.add("γ'")
        if "强化相" in query:
            phrases.add("γ'强化相")
    if "gamma double prime" in lowered or "γ double prime" in lowered:
        phrases.add("γ''")
        if "强化相" in query:
            phrases.add("γ''强化相")
    cjk = "".join(re.findall(r"[\u4e00-\u9fff]", query))
    for size in (6, 5, 4, 3):
        for index in range(0, max(0, len(cjk) - size + 1)):
            phrases.add(cjk[index : index + size])
    return sorted(phrases, key=len, reverse=True)


def query_words(query: str) -> list[str]:
    return sorted(set(re.findall(r"[a-z0-9][a-z0-9_\-/.]{1,}", query.lower())), key=len, reverse=True)


def lexical_score(query: str, title: str, text: str, metadata_json: str) -> float:
    title = title or ""
    text = text or ""
    lower_title = title.lower()
    lower_text = text.lower()
    score = 0.0

    try:
        metadata = json.loads(metadata_json or "{}")
    except json.JSONDecodeError:
        metadata = {}
    term = str(metadata.get("term") or "")
    english = str(metadata.get("english") or "")

    for phrase in query_phrases(query):
        phrase_lower = phrase.lower()
        if phrase and (phrase == term or phrase_lower == english.lower()):
            score += 6.0 + min(len(phrase) * 0.08, 0.8)
        elif phrase in title or phrase_lower in lower_title:
            score += 1.4 + min(len(phrase) * 0.04, 0.45)
        elif phrase in text or phrase_lower in lower_text:
            score += 0.45 + min(len(phrase) * 0.02, 0.25)

    for word in query_words(query):
        if word == english.lower():
            score += 1.4
        elif word in lower_title:
            score += 0.7
        elif word in lower_text:
            score += 0.18

    return score


def main(argv: list[str]) -> int:
    load_env_file(ROOT / ".env")
    args = parse_args(argv)
    try:
        from pymilvus import MilvusClient
    except ImportError as exc:
        raise RuntimeError("pymilvus is not installed. Run: pip install -r requirements-rag.txt") from exc

    client = MilvusClient(str(Path(args.db_path).expanduser()))
    query_vector = embed_texts([args.query], mode=args.embedding_mode, dimension=args.embedding_dim, batch_size=1)
    candidate_limit = args.candidate_limit or max(args.limit * 8, 40)
    results = client.search(
        collection_name=args.collection,
        data=query_vector,
        limit=candidate_limit,
        output_fields=["text", "title", "source_type", "source_uri", "metadata_json"],
    )
    for hits in results:
        reranked = []
        for hit in hits:
            entity = hit.get("entity", {})
            rerank_score = lexical_score(
                args.query,
                entity.get("title") or "",
                entity.get("text") or "",
                entity.get("metadata_json") or "",
            )
            vector_distance = float(hit.get("distance") or 0.0)
            final_score = vector_distance + rerank_score
            reranked.append((final_score, rerank_score, vector_distance, hit, entity))
        reranked.sort(key=lambda item: item[0], reverse=True)

        emitted = 0
        for final_score, rerank_score, vector_distance, hit, entity in reranked:
            if final_score < args.min_score:
                continue
            print(
                json.dumps(
                    {
                        "id": hit.get("id"),
                        "distance": final_score,
                        "vector_distance": vector_distance,
                        "rerank_score": rerank_score,
                        "title": entity.get("title"),
                        "source_type": entity.get("source_type"),
                        "source_uri": entity.get("source_uri"),
                        "metadata_json": entity.get("metadata_json"),
                        "text": (entity.get("text") or "")[:300],
                    },
                    ensure_ascii=False,
                )
            )
            emitted += 1
            if emitted >= args.limit:
                break
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
