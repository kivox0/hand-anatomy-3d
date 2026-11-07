"""Локальный сервер для проверки сайта: python tools/serve.py, потом http://localhost:5500

То же, что `python -m http.server 5500`, но просит браузер не хранить файлы в кэше.
Иначе после правок браузер иногда показывает старую версию .js-файлов.
"""

import http.server
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # папка проекта


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    http.server.test(HandlerClass=NoCacheHandler, port=5500, bind="127.0.0.1")
