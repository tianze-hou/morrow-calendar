"""把本地改动推到 GitHub（本机 github.com HTTPS 不通时走 API 通道）。"""
import json
import os
import subprocess
import sys
import tempfile

REPO = "tianze-hou/morrow-calendar"
BRANCH = "main"
MESSAGE = """服务器可自主从 GitHub 更新，不必再在本地打包上传

新增 deploy/update-from-github.sh：在服务器上一条命令即可拉远端版本并重新部署。
不走 git pull，因为 github.com 的 HTTPS 在很多网络里超时；改为用 api.github.com
解析 commit sha、用 codeload.github.com 下载该 sha 的源码包，仓库公开时全程免鉴权。
流程含备份数据库、保存回滚点、失败自动回滚、记录 .deploy-version。

附带修掉两个会真的让服务起不来的坑：
- deploy.sh 安装 systemd 单元时写死 /usr/bin/node，而 node 常常装在
  /usr/local/bin，systemd 直接 203/EXEC 反复重启；改为按本机实际路径替换。
- better-sqlite3 的预编译二进制下载不到时会静默回退 WASM 驱动，而 WASM
  不支持 WAL 模式的生产库；改为检测缺失时就地编译。
- 新装的 env 模板默认 DB_DRIVER=wasm，同样是上面那个雷，改为留空走自动。

文档：deployment.md 第 7 节拆成「服务器直接更新」与「git 工作副本更新」两条路。
"""


def gh(path, method="GET", body=None, jq=None):
    cmd = ["gh", "api", path, "-X", method]
    if jq:
        cmd += ["--jq", jq]
    input_bytes = None
    tmp = None
    if body is not None:
        cmd += ["--input", "-"]
        input_bytes = json.dumps(body).encode()
    r = subprocess.run(cmd, input=input_bytes, capture_output=True)
    if r.returncode != 0:
        print("gh 调用失败:", r.stderr.decode(errors="replace")[:600])
        sys.exit(1)
    out = r.stdout.decode().strip()
    return out


def gh_json(path, method="GET", body=None):
    cmd = ["gh", "api", path, "-X", method]
    input_bytes = None
    if body is not None:
        cmd += ["--input", "-"]
        input_bytes = json.dumps(body).encode()
    r = subprocess.run(cmd, input=input_bytes, capture_output=True)
    if r.returncode != 0:
        print("gh 调用失败:", r.stderr.decode(errors="replace")[:600])
        sys.exit(1)
    return json.loads(r.stdout.decode())


# 1. 收集本地改动
status = subprocess.run(
    ["git", "status", "--porcelain"], capture_output=True, text=True
).stdout.splitlines()
changed = []
for line in status:
    state = line[:2].strip()
    path = line[3:].strip().strip('"')
    if state in ("M", "A", "??"):
        changed.append(path)
    else:
        print("跳过非新增/修改状态:", state, path)
if not changed:
    print("没有改动")
    sys.exit(0)
print("将提交:", changed)

# 2. 远端基线
ref_sha = gh(f"repos/{REPO}/git/refs/heads/{BRANCH}", jq=".object.sha")
print("远端 HEAD:", ref_sha[:8])

# 3. 为每个文件建 blob
tree = []
for path in changed:
    with open(path, "rb") as f:
        content = f.read()
    blob = gh_json(f"repos/{REPO}/git/blobs", "POST", {
        "content": content.decode("utf-8"),
        "encoding": "utf-8",
    })
    tree.append({"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]})
    print("  blob", path, blob["sha"][:8])

# 4. 建 tree
new_tree = gh_json(f"repos/{REPO}/git/trees", "POST", {
    "base_tree": ref_sha,
    "tree": tree,
})
print("tree:", new_tree["sha"][:8])

# 5. 建 commit
commit = gh_json(f"repos/{REPO}/git/commits", "POST", {
    "message": MESSAGE,
    "tree": new_tree["sha"],
    "parents": [ref_sha],
})
print("commit:", commit["sha"][:8])

# 6. 移动分支指针
gh(f"repos/{REPO}/git/refs/heads/{BRANCH}", "PATCH", {"sha": commit["sha"]})
print("已更新 refs/heads/main ->", commit["sha"][:8])
