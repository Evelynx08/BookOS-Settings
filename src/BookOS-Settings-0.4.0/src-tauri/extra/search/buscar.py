#!/usr/bin/env python3
"""BookOS semantic search — query CLI, JSON output."""
import sys, json, argparse
from pathlib import Path

MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
DB_DIR = Path.home() / ".local/share/bookos-search/db"
COLL   = "archivos"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query", nargs="+")
    ap.add_argument("-n", "--top", type=int, default=10)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    import chromadb
    from sentence_transformers import SentenceTransformer
    modelo = SentenceTransformer(MODEL_NAME)
    cliente = chromadb.PersistentClient(path=str(DB_DIR))
    try:
        col = cliente.get_collection(COLL)
    except Exception:
        print(json.dumps({"error":"DB vacía — ejecuta indexador primero"}))
        sys.exit(1)

    q = " ".join(args.query)
    vec = modelo.encode(q, normalize_embeddings=True).tolist()
    res = col.query(query_embeddings=[vec], n_results=args.top*2,
                    include=["documents","metadatas","distances"])

    # dedupe por ruta, guardar mejor chunk por archivo
    seen = {}
    for doc, meta, dist in zip(res["documents"][0], res["metadatas"][0], res["distances"][0]):
        ruta = meta["ruta"]
        score = max(0.0, 1.0 - dist)
        if ruta not in seen or score > seen[ruta]["score"]:
            seen[ruta] = {"ruta": ruta, "score": score, "fragmento": doc[:240]}
    out = sorted(seen.values(), key=lambda x: -x["score"])[:args.top]

    if args.json:
        print(json.dumps(out, ensure_ascii=False))
    else:
        for r in out:
            print(f"[{r['score']*100:5.1f}%] {r['ruta']}")
            print(f"   {r['fragmento']}\n")

if __name__ == "__main__":
    main()
