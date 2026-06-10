"""Дев-сервер арены: статика без кэша (правки видны по F5) + многопоточность
(большие FBX и текстуры грузятся параллельно).

Запуск: python serve.py [порт]   (по умолчанию 8765)
"""
import functools
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 8765))
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        # index.html, открытый как file://, пингует сервер, чтобы самому
        # перейти в игру — разрешаем ему этот запрос
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, *args):
        pass  # не засоряем консоль


class Server(http.server.ThreadingHTTPServer):
    # На Windows дефолтный SO_REUSEADDR позволяет ДВУМ серверам сесть на один
    # порт (соединения делятся непредсказуемо). Отключаем, чтобы повторный
    # запуск честно получал "порт занят" и выходил с подсказкой.
    allow_reuse_address = os.name != "nt"


if __name__ == "__main__":
    try:
        server = Server(("", PORT), functools.partial(Handler, directory=ROOT))
    except OSError:
        # порт занят — сервер уже запущен (например, второй клик по start.bat);
        # это не ошибка, игра доступна по тому же адресу
        print(f"server already running: http://localhost:{PORT}")
        sys.exit(0)
    print(f"arena dev server: http://localhost:{PORT}")
    server.serve_forever()
