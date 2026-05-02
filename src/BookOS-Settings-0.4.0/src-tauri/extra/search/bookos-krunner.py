#!/usr/bin/env python3
"""BookOS semantic KRunner plugin.
Implements org.kde.krunner1 D-Bus interface for Plasma 6.
"""
import sys, json, subprocess, os
import dbus, dbus.service, dbus.mainloop.glib
from gi.repository import GLib

SEARCH_DIR = "/opt/bookos-search"
VENV_PY    = f"{SEARCH_DIR}/venv/bin/python"
BUSCAR     = f"{SEARCH_DIR}/buscar.py"
DB_DIR     = os.path.expanduser("~/.local/share/bookos-search/db")
BUS_NAME   = "org.bookos.SemanticSearch"
OBJ_PATH   = "/bookos/SemanticSearch"
MIN_LEN    = 3

def is_ready():
    return os.path.isfile(VENV_PY) and os.path.isdir(DB_DIR)

def semantic_query(query: str, top: int = 8):
    if not is_ready():
        return []
    try:
        out = subprocess.run(
            [VENV_PY, BUSCAR, query, "--json", "-n", str(top)],
            capture_output=True, text=True, timeout=8,
            env={**os.environ,
                 "SENTENCE_TRANSFORMERS_HOME": f"{SEARCH_DIR}/models",
                 "TRANSFORMERS_OFFLINE": "1"}
        )
        return json.loads(out.stdout.strip()) if out.stdout.strip() else []
    except Exception:
        return []


class BookOSRunner(dbus.service.Object):
    def __init__(self, conn, obj_path):
        super().__init__(conn, obj_path)

    @dbus.service.method("org.kde.krunner1",
                         in_signature="s",
                         out_signature="a(sssida{sv})")
    def Match(self, query: str):
        query = query.strip()
        if len(query) < MIN_LEN:
            return []
        results = semantic_query(query)
        out = []
        for r in results:
            ruta     = r.get("ruta", "")
            score    = float(r.get("score", 0.0))
            fragment = r.get("fragmento", "")[:120]
            fname    = os.path.basename(ruta)
            # type 30 = PossibleMatch, 50 = InformationalMatch, 100 = ExactMatch
            mtype = 100 if score > 0.85 else (50 if score > 0.60 else 30)
            props = dbus.Dictionary({
                "subtext": dbus.String(f"{ruta}  ·  {fragment}"),
                "urls":    dbus.Array([dbus.String(f"file://{ruta}")], signature="s"),
            }, signature="sv")
            out.append((
                dbus.String(ruta),        # id
                dbus.String(fname),       # display text
                dbus.String("document"),  # icon name
                dbus.Int32(mtype),        # match type
                dbus.Double(score),       # relevance
                props
            ))
        return out

    @dbus.service.method("org.kde.krunner1",
                         in_signature="ss",
                         out_signature="")
    def Run(self, match_id: str, action_id: str):
        subprocess.Popen(["xdg-open", match_id])

    @dbus.service.method("org.kde.krunner1",
                         in_signature="",
                         out_signature="a(sss)")
    def Actions(self):
        return []

    @dbus.service.method("org.kde.krunner1",
                         in_signature="",
                         out_signature="")
    def Teardown(self):
        pass


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    session_bus = dbus.SessionBus()
    try:
        bus_name = dbus.service.BusName(BUS_NAME, bus=session_bus,
                                        allow_replacement=True, replace_existing=True)
    except dbus.exceptions.NameExistsException:
        sys.exit(0)
    BookOSRunner(session_bus, OBJ_PATH)
    GLib.MainLoop().run()

if __name__ == "__main__":
    main()
