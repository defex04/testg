"""Временный реверс-прокси админки для предпросмотра: отдаёт /admin и
/admin/api/* с живого бэкенда (Docker, localhost:8080), чтобы в превью
работали и рендер, и данные. Порт берёт из PORT (autoPort предпросмотра)."""
import http.server
import os
import urllib.request
import urllib.error

PORT = int(os.environ.get("PORT", 8799))
BACKEND = "http://localhost:8080"

# На машине задана SSLKEYLOGFILE с кавычками в значении — ssl-модуль Python
# падает на ней (Errno 22) даже для http-запросов. Локальному прокси она
# не нужна — убираем из окружения процесса.
os.environ.pop("SSLKEYLOGFILE", None)


class H(http.server.BaseHTTPRequestHandler):
    def _proxy(self):
        path = self.path if self.path != "/" else "/admin"
        body = None
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            body = self.rfile.read(length)
        req = urllib.request.Request(BACKEND + path, data=body, method=self.command)
        for k in ("Content-Type", "x-admin-key", "Authorization"):
            v = self.headers.get(k)
            if v:
                req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
                self.send_response(r.status)
                ct = r.headers.get("Content-Type")
                if ct:
                    self.send_header("Content-Type", ct)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type") or "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:  # бэкенд не поднят
            msg = ('{"error":"backend_unreachable: %s"}' % e).encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)

    do_GET = do_POST = do_PUT = do_DELETE = _proxy

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("", PORT), H).serve_forever()
