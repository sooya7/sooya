import sys, time
sys.path.insert(0, r"c:\Users\iulze\Desktop")
from ssh_config import ssh_connect, run

ssh = ssh_connect()
run(ssh, "systemctl restart sooya")
time.sleep(3)
run(ssh, "systemctl is-active sooya")
run(ssh, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/health/live")
for name in ["index-DAAyMTIU.js", "index-CSydWzHd.js", "index-CP7XueKf.js"]:
    run(ssh, f"curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1:8788/assets/{name}")
ssh.close()
print("DONE")
