"""部署新 bundle 绕开 CF 缓存污染;保留旧 bundle;部署后立即重启"""
import sys, hashlib, time
sys.path.insert(0, r"c:\Users\iulze\Desktop")
from ssh_config import ssh_connect, run

STAMP = time.strftime("%Y%m%d%H%M%S")
LOCAL = r"c:\Users\iulze\Desktop\sooya"

def sha256(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()

FILES = [
    (LOCAL + r"\packages\web\dist\assets\index-uRK2xY8I.js", "/opt/sooya/current/public/assets/index-uRK2xY8I.js"),
    (LOCAL + r"\packages\web\dist\index.html", "/opt/sooya/current/public/index.html"),
    (LOCAL + r"\packages\web\dist\sw.js", "/opt/sooya/current/public/sw.js"),
    (LOCAL + r"\packages\web\dist\manifest.webmanifest", "/opt/sooya/current/public/manifest.webmanifest"),
]

ssh = ssh_connect()
sftp = ssh.open_sftp()

for local, remote in FILES:
    local_hash = sha256(local)
    sftp.put(local, remote)
    out, _, rc = run(ssh, f"sha256sum {remote}")
    assert rc == 0 and local_hash in out, f"HASH MISMATCH: {remote}"
    print(f"OK {remote}")

run(ssh, "chown sooya:sooya /opt/sooya/current/public/index.html /opt/sooya/current/public/sw.js /opt/sooya/current/public/manifest.webmanifest /opt/sooya/current/public/assets/index-uRK2xY8I.js")

# 关键: 静态清单在启动时缓存,新增文件后必须重启
run(ssh, "systemctl restart sooya")
time.sleep(3)
run(ssh, "systemctl is-active sooya; curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/health/live")
for name in ["index-uRK2xY8I.js", "index-DAAyMTIU.js", "index-CSydWzHd.js", "index-CP7XueKf.js"]:
    run(ssh, f"curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1:8788/assets/{name}")

sftp.close()
ssh.close()
print("\nDONE")
