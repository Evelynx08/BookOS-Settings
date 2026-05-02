#!/usr/bin/env python3
"""BookOS semantic indexer — paraphrase-multilingual-MiniLM-L12-v2."""
import os, sys, json, argparse, hashlib
from pathlib import Path

MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
DB_DIR   = Path.home() / ".local/share/bookos-search/db"
CFG_FILE = Path.home() / ".config/bookos-search/config.json"
COLL     = "archivos"

DEFAULT_CFG = {
    "directorios": [str(Path.home()/"Documentos"), str(Path.home()/"Escritorio")],
    "extensiones": [".txt",".md",".py",".pdf",".sh",".json",".rs",".js",".ts",".html",".css",".tex",".org"],
    "max_bytes":   5_000_000,
    "chunk_size":  500,
    "chunk_stride":400,
}

def load_cfg():
    if CFG_FILE.exists():
        try: return {**DEFAULT_CFG, **json.loads(CFG_FILE.read_text())}
        except Exception: pass
    CFG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CFG_FILE.write_text(json.dumps(DEFAULT_CFG, indent=2))
    return DEFAULT_CFG

def init_backend():
    import chromadb
    from sentence_transformers import SentenceTransformer
    DB_DIR.mkdir(parents=True, exist_ok=True)
    modelo = SentenceTransformer(MODEL_NAME)
    cliente = chromadb.PersistentClient(path=str(DB_DIR))
    col = cliente.get_or_create_collection(COLL)
    return modelo, col

def leer(ruta: Path, max_bytes: int):
    try:
        if ruta.stat().st_size > max_bytes: return None
        if ruta.suffix.lower() == ".pdf":
            try:
                import pypdf
                return "\n".join((p.extract_text() or "") for p in pypdf.PdfReader(str(ruta)).pages)
            except Exception: return None
        return ruta.read_text(errors="ignore")
    except Exception:
        return None

def chunkify(texto: str, size: int, stride: int):
    if len(texto) <= size: return [texto]
    out = []
    i = 0
    while i < len(texto):
        out.append(texto[i:i+size])
        i += stride
    return out

def file_id(ruta: Path, i: int):
    h = hashlib.sha1(str(ruta).encode()).hexdigest()[:16]
    return f"{h}::{i}"

def remove_file(col, ruta: Path):
    try:
        col.delete(where={"ruta": str(ruta)})
    except Exception as e:
        print(f"[warn] delete {ruta}: {e}", file=sys.stderr)

def index_file(modelo, col, ruta: Path, cfg):
    if ruta.suffix.lower() not in cfg["extensiones"]: return 0
    texto = leer(ruta, cfg["max_bytes"])
    if not texto or len(texto) < 50: return 0
    remove_file(col, ruta)
    chunks = chunkify(texto, cfg["chunk_size"], cfg["chunk_stride"])
    embs = modelo.encode(chunks, batch_size=32, show_progress_bar=False, normalize_embeddings=True).tolist()
    ids   = [file_id(ruta,i) for i in range(len(chunks))]
    metas = [{"ruta": str(ruta), "chunk": i} for i in range(len(chunks))]
    col.upsert(ids=ids, documents=chunks, embeddings=embs, metadatas=metas)
    return len(chunks)

def index_all(modelo, col, cfg):
    total_files = total_chunks = 0
    for d in cfg["directorios"]:
        base = Path(d)
        if not base.exists(): continue
        for ruta in base.rglob("*"):
            if not ruta.is_file(): continue
            if any(p.startswith(".") for p in ruta.parts): continue
            n = index_file(modelo, col, ruta, cfg)
            if n:
                total_files += 1
                total_chunks += n
    print(f"Indexados: {total_files} archivos, {total_chunks} fragmentos, total en DB: {col.count()}")

def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--archivo", help="indexa un solo archivo")
    g.add_argument("--borrar",  help="elimina entradas de un archivo")
    g.add_argument("--full",    action="store_true", help="reindex completo")
    ap.add_argument("--stats",  action="store_true")
    args = ap.parse_args()

    cfg = load_cfg()
    modelo, col = init_backend()

    if args.stats:
        print(f"fragmentos: {col.count()}"); return
    if args.borrar:
        remove_file(col, Path(args.borrar)); return
    if args.archivo:
        n = index_file(modelo, col, Path(args.archivo), cfg)
        print(f"indexados {n} fragmentos de {args.archivo}"); return
    # por defecto: full
    index_all(modelo, col, cfg)

if __name__ == "__main__":
    main()
