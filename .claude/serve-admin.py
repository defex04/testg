"""Временный статик-сервер админки для предпросмотра (рендер клиента).
Порт берёт из PORT (autoPort предпросмотра). Отдаёт backend/public без кэша."""
import functools, http.server, os

PORT = int(os.environ.get("PORT", 8799))
ROOT = r"C:/Users/andre/Downloads/new/server/mmorpg-local/backend/public"


class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(
        ("", PORT), functools.partial(H, directory=ROOT)).serve_forever()
