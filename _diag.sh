#!/bin/bash
echo "=== uptime ==="
uptime
echo "=== docker ps (all) ==="
sudo docker ps -a --format '{{.Names}} | {{.Status}} | {{.Ports}}'
echo "=== listening 80/443/8080 ==="
sudo ss -tlnp | grep -E ':80|:443|:8080' || echo "none listening"
echo "=== caddy logs tail ==="
sudo docker logs --tail 20 mmo-caddy 2>&1
echo "=== local health via caddy public host ==="
curl -s -w '\nHTTP=%{http_code}\n' https://4.231.90.10.sslip.io/api/health
