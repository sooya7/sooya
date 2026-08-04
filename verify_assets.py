import sys
sys.path.insert(0, r"c:\Users\iulze\Desktop")
from ssh_config import ssh_connect, run

ssh = ssh_connect()
run(ssh, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/assets/index-DAAyMTIU.js")
run(ssh, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/assets/index-CSydWzHd.js")
run(ssh, "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/assets/index-CP7XueKf.js")
run(ssh, "chown sooya:sooya /opt/sooya/current/public/assets/index-C*.js; ls -la /opt/sooya/current/public/assets/")
ssh.close()
