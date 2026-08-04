import sys
sys.path.insert(0, r"c:\Users\iulze\Desktop")
from ssh_config import ssh_connect, run

ssh = ssh_connect()
run(ssh, "curl -sI http://127.0.0.1:8788/assets/nonexistent123.js | head -10")
run(ssh, "curl -sI http://127.0.0.1:8788/assets/index-DAAyMTIU.js | head -10")
ssh.close()
