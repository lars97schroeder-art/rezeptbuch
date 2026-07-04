#!/usr/bin/env python3
"""Rezeptbuch-Admin – lokales Pflege-Tool.

Start:  python3 admin/admin.py   (oder Doppelklick auf "Rezept-Admin.command")
Öffnet automatisch http://localhost:8765 im Browser.
Nur Python-Standardbibliothek; Fotos werden mit macOS "sips" verkleinert.
"""

import base64
import json
import re
import subprocess
import tempfile
import threading
import time
import webbrowser
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT / "data" / "recipes.json"
IMG_DIR = ROOT / "data" / "images"
ADMIN_HTML = Path(__file__).resolve().parent / "admin.html"
PORT = 8765


def load_data():
    if DATA_FILE.exists():
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    return {"version": 0, "updated": "", "recipes": []}


def save_data(data):
    data["version"] = int(data.get("version", 0)) + 1
    data["updated"] = date.today().isoformat()
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def slugify(title):
    t = title.lower()
    for a, b in [("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")]:
        t = t.replace(a, b)
    t = re.sub(r"[^a-z0-9]+", "-", t).strip("-")
    return t or "rezept"


def save_image(data_url, slug):
    """Bild aus einer data:-URL speichern, per sips auf max. 1200px verkleinern.

    Der Dateiname bekommt einen Zeitstempel, damit die Handys ein ersetztes
    Foto als neu erkennen (alte Dateien werden vom Aufrufer gelöscht).
    """
    raw = base64.b64decode(data_url.split(",", 1)[-1])
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    out = IMG_DIR / f"{slug}-{int(time.time())}.jpg"
    with tempfile.NamedTemporaryFile(suffix=".img", delete=False) as f:
        f.write(raw)
        tmp = Path(f.name)
    try:
        subprocess.run(
            ["sips", "-s", "format", "jpeg", "-s", "formatOptions", "80",
             "-Z", "1200", str(tmp), "--out", str(out)],
            check=True, capture_output=True,
        )
    finally:
        tmp.unlink(missing_ok=True)
    return f"data/images/{out.name}"


def delete_image(recipe):
    img = recipe.get("image", "")
    if img:
        path = ROOT / img
        if path.is_file() and IMG_DIR in path.parents:
            path.unlink()


def run_git(*args):
    return subprocess.run(
        ["git", "-C", str(ROOT), *args], capture_output=True, text=True
    )


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # Konsole ruhig halten

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/" or path == "/index.html":
            body = ADMIN_HTML.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path == "/api/recipes":
            self.send_json(load_data())
        elif path.startswith("/data/images/"):
            file = (ROOT / path.lstrip("/")).resolve()
            if file.is_file() and IMG_DIR in file.parents:
                body = file.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_json({"error": "nicht gefunden"}, 404)
        else:
            self.send_json({"error": "nicht gefunden"}, 404)

    def do_POST(self):
        try:
            if self.path == "/api/save":
                self.handle_save()
            elif self.path == "/api/delete":
                self.handle_delete()
            elif self.path == "/api/publish":
                self.handle_publish()
            else:
                self.send_json({"error": "nicht gefunden"}, 404)
        except Exception as e:  # Fehler lesbar an die Oberfläche geben
            self.send_json({"error": str(e)}, 500)

    def handle_save(self):
        payload = self.read_body()
        recipe = payload["recipe"]
        if not recipe.get("title", "").strip():
            return self.send_json({"error": "Titel fehlt"}, 400)

        data = load_data()
        existing = next(
            (r for r in data["recipes"] if r["id"] == recipe.get("id")), None
        )

        if not recipe.get("id"):
            slug = slugify(recipe["title"])
            ids = {r["id"] for r in data["recipes"]}
            candidate, n = slug, 2
            while candidate in ids:
                candidate, n = f"{slug}-{n}", n + 1
            recipe["id"] = candidate

        if payload.get("imageDataUrl"):
            if existing:
                delete_image(existing)
            recipe["image"] = save_image(payload["imageDataUrl"], recipe["id"])
        elif existing and not payload.get("removeImage"):
            recipe["image"] = existing.get("image", "")
        else:
            if existing and payload.get("removeImage"):
                delete_image(existing)
            recipe["image"] = ""

        if existing:
            data["recipes"][data["recipes"].index(existing)] = recipe
        else:
            data["recipes"].append(recipe)
        save_data(data)
        self.send_json({"ok": True, "data": data})

    def handle_delete(self):
        payload = self.read_body()
        data = load_data()
        recipe = next(
            (r for r in data["recipes"] if r["id"] == payload.get("id")), None
        )
        if not recipe:
            return self.send_json({"error": "Rezept nicht gefunden"}, 404)
        delete_image(recipe)
        data["recipes"].remove(recipe)
        save_data(data)
        self.send_json({"ok": True, "data": data})

    def handle_publish(self):
        steps = []
        for args in (
            ["add", "-A"],
            ["commit", "-m", "Rezepte aktualisiert"],
            ["push"],
        ):
            result = run_git(*args)
            out = (result.stdout + result.stderr).strip()
            steps.append(f"$ git {' '.join(args)}\n{out}")
            if result.returncode != 0:
                if args[0] == "commit" and "nothing to commit" in out:
                    return self.send_json(
                        {"ok": True, "log": "Keine Änderungen zu veröffentlichen."}
                    )
                return self.send_json(
                    {"error": "Git-Fehler", "log": "\n\n".join(steps)}, 500
                )
        self.send_json({"ok": True, "log": "\n\n".join(steps)})


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://localhost:{PORT}"
    print(f"Rezeptbuch-Admin läuft: {url}")
    print("Beenden mit Ctrl+C")
    threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nTschüss!")


if __name__ == "__main__":
    main()
