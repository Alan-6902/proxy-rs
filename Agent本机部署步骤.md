# Proxy RS：交给 Agent 的本机部署步骤

适用项目：`/Users/ma/cache/AI/kiro-rs`。目标：把当前工作区打包为本机架构的应用，
安装到 `/Applications/Proxy RS.app`，校验并启动，最后清理本包 Rust 产物。
本文对应 2026-09-30 的部署脚本；执行前核对命令仍存在。

## 直接复制给 Agent 的指令

```text
请按 /Users/ma/cache/AI/kiro-rs/Agent本机部署步骤.md，
部署 /Users/ma/cache/AI/kiro-rs 当前工作区到本机 /Applications/Proxy RS.app。

我授权本次完整执行：检查环境和工作区、必要的依赖安装、打包、正常退出旧应用、
替换安装、校验并启动、检查运行状态，以及脚本限定范围内的永久清理。
打包包含当前工作区的未提交改动；保留这些改动，不替我提交、推送、合并或切换分支。
允许替换时短暂中断本机反代。允许永久清理旧 dist、成功安装后的本次暂存和旧版应用备份、
kiro-rs 本包 Debug/Release 产物与超过一天的白名单测试临时目录。
保留第三方依赖缓存、最新安装包、源码、配置、账号库及账号库备份，不清空废纸篓。

常规步骤直接执行，不反复确认。不要强制杀应用，不扩大清理范围，不输出密钥或账号数据。
只有遇到需要新增授权、无法安全恢复的错误或必须由我处理的阻塞时才通过结构化工具询问。
运行 npm run deploy:current 完成全过程；不要只打包就结束。
必须分别报告打包、安装校验、运行验证和缓存清理结果，不能用退出码 0 代替全部验证。
```

转交上面的指令即包含该次部署所需的正常退出、替换和限定清理授权，无需再次逐项确认。
**仅打开或阅读本文不构成部署授权。** 本文不豁免宿主的项目准入或代码修改规则；
单纯执行现有脚本不要求修改源码。若排障需要修改源码，再遵循该会话的代码工作流。

## 1. 确认执行位置与前置条件

在目标机器上执行，不在其他仓库、容器或远程服务器中部署：

```bash
cd /Users/ma/cache/AI/kiro-rs
pwd
git status --short --branch
git diff --check
uname -m
command -v node npm pnpm cargo rustc
df -h . /Applications
du -sk kiro-rs-src/target proxy-rs/dist 2>/dev/null
```

- 记录当前分支、改动清单、磁盘可用空间及已有产物大小。目录不存在时记录为不存在。
- 当前工作区未提交改动已在转交指令中获准纳入打包，不为追求干净工作区执行 reset、stash、clean 或 checkout。
- 检查 `proxy-rs/package.json` 存在 `deploy:current`、`install:current`、`dist:current`。
  若入口缺失，停止并报告版本不匹配，不临时拼接删除命令代替。
- Node、npm、pnpm、Cargo 和 macOS 编译工具须可用。`proxy-rs` 依赖缺失时，在其目录按仓库锁文件和既有包管理方式安装；不升级依赖或重写锁文件。
- 部署前完成当前代码改动所需的检查。已有明确通过证据且代码未再改时不重复跑全套测试。
  部署脚本发生过改动时，运行下面的针对性测试：

```bash
cd /Users/ma/cache/AI/kiro-rs/proxy-rs
node --test scripts/build-mac-with-cleanup.test.mjs scripts/install-current-mac.test.mjs
```

检查失败时先报告具体失败，不继续覆盖已安装应用。

## 2. 一条命令完成打包、安装、校验和清理

```bash
cd /Users/ma/cache/AI/kiro-rs/proxy-rs
npm run deploy:current
```

等待命令真正结束，记录退出码与关键输出。脚本会依次执行：

1. 检查旧 `proxy-rs/dist` 占用，空闲时永久删除旧输出。
2. 构建 Rust 内嵌的 Admin 前端、Rust Release 二进制与 Electron 应用，生成本机架构的 `.app`。
3. 校验新包，并复制到 Applications 内的暂存目录。核对全包内容、执行权限、软链和签名。
4. 正常退出旧应用，等待释放占用，替换 `/Applications/Proxy RS.app`，再次校验并请求启动。
5. 安装通过后，由 Cargo 按 `kiro-rs` 包分别清理 Debug 和 Release 产物，保留第三方依赖缓存。
6. 清理超过一天未活动的 `account-store-test-<UUID>`、`credential-identity-test-<UUID>` 目录。

若 Applications 已是与 dist 一致的包，则跳过退出、复制和重启，直接复验并清理。
纯打包命令 `npm run dist:current` 不会执行安装后的 target 清理。

**已打好包，只补做安装或清理**时使用：

```bash
cd /Users/ma/cache/AI/kiro-rs/proxy-rs
npm run install:current
```

使用此入口前必须确认 dist 就是本次要部署的包；它不会重新编译最近修改的源码。
同包分支不会主动启动已关闭的应用，运行检查发现它未运行时，执行：

```bash
open -a '/Applications/Proxy RS.app'
```

## 3. 验证安装与实际运行

脚本的签名及包内容校验通过，说明复制完整；`open` 成功仅表示系统接受启动请求。
还需确认应用及内置反代确实来自 Applications，并检查本机服务：

```bash
/usr/bin/codesign --verify --deep --strict '/Applications/Proxy RS.app'
pgrep -fl '/Applications/Proxy RS.app/Contents/MacOS/Proxy RS'
pgrep -fl '/Applications/Proxy RS.app/Contents/Resources/kiro-rs'
lsof -nP -iTCP:12888 -sTCP:LISTEN
curl --noproxy '*' --max-time 5 -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:12888/admin
```

默认端口是 `12888`；如本机配置过其他端口，只读取配置中的端口信息并替换检查参数，
不要输出整个 `~/kiro-rs/config/config.json`。检查监听进程与上述已安装反代进程一致，
监听地址符合本机配置，Admin 页面应返回 `200`。
启动可能需要几秒，最多等待约 60 秒并间隔复查；持续失败则报告运行验证失败。

若需要进一步验证受认证 Admin API，只在进程内读取密钥并发起本机请求，
仅输出状态码及必要的脱敏结论；不要把密钥放进命令参数、日志、对话或交付文件，
不要打印账号库、token 或完整 API 响应。`/v1/models` 未认证返回 `401` 不能用来判定服务故障。

## 4. 核对清理结果

```bash
cd /Users/ma/cache/AI/kiro-rs
du -sk kiro-rs-src/target proxy-rs/dist 2>/dev/null
df -h . /Applications
git status --short --branch
```

必须读取部署输出中的 Cargo 清理结果和测试目录计数。
出现“跳过剩余缓存清理”时，即使命令退出码为 `0`，也只能报告“安装成功，清理未全部完成”。

target 仍存在是预期行为：第三方依赖和最近一天的测试目录会保留。
报告目录占用减少量与磁盘可用空间变化时分开描述；其他进程写入及 APFS 会影响后者。
不要为了清零 target 运行全量 `cargo clean` 或直接删除整个目录。
清理完成后不要额外运行 Cargo 编译、测试来“验收”，否则会重新生成刚清理的产物。

## 5. 失败处理

| 情况 | Agent 应如何处理 |
|---|---|
| 打包失败 | 保留 target 与已安装应用，报告失败阶段；不拿旧 dist 冒充新包安装 |
| 旧 dist 或应用被占用 | 等正常任务结束，必要时按已获授权正常退出确切的 Proxy RS；不强制杀进程 |
| 应用拒绝退出、权限不足 | 保留旧应用和 target，报告阻塞；不要自行提权或改系统权限 |
| 暂存副本校验失败 | 不替换旧应用，保留 target；检查复制、磁盘和签名错误 |
| 替换后包校验失败 | 脚本尝试恢复旧应用；确认恢复结果，必要时重新打开旧应用；恢复失败则保留暂存并报告路径 |
| 启动请求失败 | 脚本保留已安装包和暂存备份，不清 target；按实际输出定位备份，不直接删除 |
| 启动请求成功但运行验证失败 | 报告“安装完成、运行验证失败”；成功安装时旧版备份可能已删除，不能承诺仍可直接回滚 |
| target 占用或 Cargo 锁超时 | 保留剩余缓存；任务自然结束后可重跑 install:current，不杀语言服务或构建进程 |
| 提示存在锁目录 | 检查相关进程；活动任务存在时等待。确认为中断遗留的空目录后才用 rmdir 移除，不能盲删 |

锁位置为 `proxy-rs/build/.mac-package.lock` 与 `/Applications/.proxy-rs-install.lock`。
前者保护本工作区，后者防止不同 checkout/worktree 同时替换同一个应用。
如修复需要超出本次授权的源码修改、数据修改或扩大删除范围，先明确报告并取得相应授权。

## 6. 最终汇报格式

```text
部署：成功 / 部分完成 / 失败（注明阶段）
来源：项目绝对路径、分支、HEAD；是否包含未提交改动
安装：/Applications/Proxy RS.app；包一致性、签名校验结果
运行：应用进程、内置反代进程、本机端口和 Admin 页面检查结果
清理：本包 Debug/Release 的执行或跳过结果、测试目录清理数量
空间：target 清理前后大小；磁盘可用空间变化单独列出
保留：第三方依赖、最新安装包、源码、配置和账号库
异常：实际遗留锁或备份路径、尚未完成事项；没有则写无
```

实现及背景说明见 [构建与部署](kiro-rs-src/docs/构建与部署.md)。
