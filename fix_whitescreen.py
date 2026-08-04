"""恢复被移走的旧前端 bundle,避免缓存旧 index.html 的设备白屏"""
import sys
sys.path.insert(0, r"c:\Users\iulze\Desktop")
from ssh_config import ssh_connect, run

ssh = ssh_connect()

run(ssh, "ls /opt/sooya/current/public/assets/")
run(ssh, "ls /opt/sooya/shared/backups/ | grep 'index-'")
# 把移走的旧 bundle 恢复回 assets(新旧并存,等新 SW 全面接管后再清理)
run(ssh, "for f in /opt/sooya/shared/backups/index-*.old; do cp \"$f\" /opt/sooya/current/public/assets/$(basename \"$f\" | sed 's/\\.[0-9]*\\.old$//'); done")
run(ssh, "ls -la /opt/sooya/current/public/assets/")
# 验证三个 bundle 都能取到
for name in ["index-CSydWzHd.js", "index-CP7XueKf.js", "index-DAAyMTIU.js"]:
    run(ssh, f"curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1:8788/assets/{name}")

ssh.close()
print("DONE")
