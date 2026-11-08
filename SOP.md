# Windows 安装 / 更新 / 发布 SOP

适用：QuillMD Windows 安装器、应用内更新、便携包和 CNB 发布。  
最近验证：2026-11-08，QuillMD `0.0.3`，Windows 11 `10.0.26300.x`。

> 原则：先确认“文件本身是否正确”，再确认“运行环境是否拦截”，最后才改安装包。
> 不要用“删除 TEMP / 重装系统 / 关闭安全软件”作为第一反应。

## 0. 症状分类

| 症状 | 优先检查 |
| --- | --- |
| 双击安装器，向导还没出现就报 `NSIS Error` / 退出码 2 | 文件哈希、所在目录的完整性标签/ACL、NSIS `System.dll`、安全软件路径拦截 |
| 安装器向导正常，但不识别旧版本 | 旧版本卸载注册项、安装路径、测试安装是否被卸载 |
| 应用内检查更新失败或 `ok:false` | 火绒等联网控制是否放行 `QuillMD.exe`、CNB 是否可访问 |
| 安装完成后应用正常，但安装器进程出现网络连接 | 安装完成页是否自动启动了应用；应用启动更新检查；安全软件云查杀 |
| 打包后的安装器在本机能开、别的机器崩溃 | 安装器内 NSIS `System.dll` 版本；Windows build |

## 1. 先校验安装包

在 Windows PowerShell：

```powershell
Get-FileHash .\QuillMD-Setup-0.0.3.exe -Algorithm SHA256
Get-FileHash .\QuillMD-Setup-0.0.3.exe -Algorithm SHA512
```

CNB/GitHub Release 的 `latest.yml` 里同时有 `sha512` 和 `size`。确认：

- 文件大小一致；
- `latest.yml` 的 `sha512` 是 **Base64**，而 `Get-FileHash -Algorithm SHA512` 默认输出
  的是十六进制；不要把两者直接字符串比较。可以先用 C#/Node 把字节转成 Base64，
  或只把 `latest.yml` 当成权威值并用安装器实际下载校验；
- 7-Zip 能完整测试：

```powershell
7z t .\QuillMD-Setup-0.0.3.exe
```

安装器内 `$PLUGINSDIR\System.dll` 应为 **NSIS 3.13 版本**，SHA-256：

```text
afe032f942e2ed0bf7494ec08ba813f5739fb522c640bde81d30ecaf9f894432
```

旧版（未修复）的哈希是：

```text
3eb38ae99653a7dbc724132ee240f6e5c4af4bfe7c01d31d23faf373f9f2eaca
```

## 2. 向导首窗之前失败：NSIS Error / exit code 2

`Error writing temporary file. Make sure your temp folder is valid.` 是 NSIS 的**通用兜底文案**，
不一定代表 TEMP 真的不可用。按顺序排查。

### 2.1 目录被标为 Low integrity（最常见）

检查：

```powershell
icacls "$env:USERPROFILE\Downloads"
```

如果看到：

```text
Everyone:(CI)(DENY)(DC)
S-1-4-...:(OI)(CI)(W,D,DC)
Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
```

说明该目录处于 Windows **低完整性**沙箱。低完整性进程无法写普通 Medium `%TEMP%`，
NSIS 会在首窗前退出码 2。此时换 TEMP、重新下载、重新打包都无效。

常见来源：**DeepSeek Harness（Horus）** 的本地工作区沙箱。它的 `app.asar` 包含：

- `workspaceWriteSid`
- `SetNamedSecurityInfoW`
- `SetEntriesInAcl`
- `Low Mandatory`
- `S-1-4-...` capability SID

当它把某个目录当作 workspace 时，会给该目录加 capability ACE、对 Everyone 拒绝删除子项，
并把目录标成 Low。`Downloads`、`Desktop` 都可能被加上；`Documents\deepseek-harness\default-workspace`
是它自己的默认工作区，通常也保持 Low。

**恢复步骤（必须按顺序）：**

1. 完全退出 DeepSeek Harness（包含托盘/后台进程）。确认没有 `DeepSeek Harness.exe`。
2. 在它里面移除 `Downloads`、`Desktop` 等真实目录的 workspace 关联；以后只给它专用目录，
   例如 `D:\AIWork`。只关闭窗口/取消 workspace 不会自动撤销已写入的 ACL。
3. 以**管理员 PowerShell** 操作。先备份：

```powershell
icacls "$env:USERPROFILE\Downloads" /save "$env:TEMP\Downloads-acl-backup.txt" /T
(Get-Acl "$env:USERPROFILE\Downloads" -Audit).Sddl |
  Set-Content "$env:TEMP\Downloads-acl-backup.sddl"
```

4. 恢复 Medium 完整性、移除 Everyone 拒绝规则、清除 ReadOnly：

```powershell
icacls "$env:USERPROFILE\Downloads" /setintegritylevel '(OI)(CI)M' /T
icacls "$env:USERPROFILE\Downloads" /remove:d "*S-1-1-0" /T
attrib -R "$env:USERPROFILE\Downloads"
```

5. 删除 capability ACE。**不要只依赖** `icacls /remove:g "*S-1-4-..."`：
   在实测中它可能输出“已成功处理 0 个文件”但 ACE 仍存在。使用 .NET ACL API：

```powershell
$path = "$env:USERPROFILE\Downloads"
$sidText = '<从 icacls 输出复制的 S-1-4-... SID>'
$sid = [System.Security.Principal.SecurityIdentifier]::new($sidText)
$acl = Get-Acl -LiteralPath $path
foreach ($rule in @($acl.Access)) {
  if ($rule.IsInherited) { continue }
  try {
    $value = $rule.IdentityReference.Translate(
      [System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    $value = [string]$rule.IdentityReference
  }
  if ($value -eq $sid.Value) {
    $acl.RemoveAccessRuleSpecific($rule) | Out-Null
  }
}
Set-Acl -LiteralPath $path -AclObject $acl
```

6. 删除完后再验证：

```powershell
icacls "$env:USERPROFILE\Downloads"
Get-Item "$env:USERPROFILE\Downloads" | Select-Object Attributes
```

应满足：

- `Mandatory Label\Medium Mandatory Level`
- 没有 `S-1-4-...`
- 没有 `Everyone ... (DENY)`
- 没有 `ReadOnly`

7. 从该目录启动安装器，确认出现 `QuillMD 安装` 首窗。

**注意：**

- 如果 DeepSeek Harness 又把该目录加回 workspace，ACL 会被重新写入。真实用户目录不要给沙箱工具当 workspace。
- `Desktop` 的模板相同，但完整性可能是 Medium；如果也由同一工具保护，按同样方式清理，只是 SID 不同。
- 不要把这个恢复流程套到系统目录或别人的目录；只操作用户明确授权的个人目录。
- 恢复只改 ACL、完整性标签和目录属性，不删除文件。

### 2.2 NSIS `System.dll` 崩溃（两个独立根因）

如果目录已经是 Medium，但首窗仍然不出现，检查 Windows 错误报告/WER：

- 故障模块：`System.dll`
- 异常代码：`0xC0000005`
- 现象：首窗前崩溃，或用户看到误导性的 NSIS Error

这个故障有两个独立层，**两个都要修**：

#### A. 旧 NSIS 3.04 的 `System.dll`

- 旧插件时间戳约 2018
- 异常偏移约 `0x1581`
- 原因：electron-builder 25.1.8 自带 NSIS 3.04 的旧 `System.dll`，在 Windows 11 build 26300
  上会访问冲突
- 修复：`build/nsis/x86-unicode/System.dll`（NSIS 3.13 版本） +
  `scripts/ci/patch-nsis-system-plugin.mjs`

#### B. `multiUser.nsh` 的 `SHGetKnownFolderPath` 调用

即使换成完整 NSIS 3.13，首窗仍可能崩溃：

- 异常偏移约 `0x1621`
- 复现：从 `Downloads` / `Desktop` / 用户目录启动时高频出现；换 cwd 时也不稳定
- 定位：逐项禁用 `ALLOW_ONLY_ONE` 后仍崩溃；替换 `multiUser.nsh` 里的
  `System::Call 'SHELL32::SHGetKnownFolderPath(... KF_FLAG_CREATE ...)'` 后，
  从 Downloads 连续 8 次启动全部正常
- 修复：`scripts/ci/patch-nsis-multiuser.mjs` 把 per-user 安装根目录固定为
  `%LOCALAPPDATA%\Programs`，不再调用这个 `System.dll` API
- 代价：极少数把 `FOLDERID_UserProgramFiles` 改到非默认位置的系统会失去该自定义；
  这是为了避免安装器直接崩溃，属于可接受的回退

两个补丁都在：

- `npm run dist`（打包前自动运行）
- `.github/workflows/release.yml`（Windows 打包前自动运行）
- 一次性 v0.0.3 回填工作流（同样运行）

**不要**在 Windows 上直接运行 `npx electron-builder --win` 而不先运行两个 patch 脚本；
否则可能生成仍会崩溃的安装器。

验证：

```powershell
# 1. 安装器内的 System.dll
7z x .\QuillMD-Setup-0.0.3.exe -o.\nsis-check
Get-FileHash '.\nsis-check\$PLUGINSDIR\System.dll' -Algorithm SHA256
# 应为 afe032f...

# 2. 从 Downloads 的当前目录重复启动首窗
# 期望：每次都出现 QuillMD 安装首窗，不再出现 0xC0000005
```

发布前还应静默安装到独立测试目录并确认返回码为 0：

```powershell
Start-Process .\QuillMD-Setup-0.0.3.exe -ArgumentList '/S','/D=D:\Work\QuillMD-test' -Wait
$LASTEXITCODE
```

同时运行首窗冒烟（GUI 进程必须存活，不能启动即崩溃）：

```powershell
.\scripts\ci\smoke-nsis-installer.ps1 -Installer .\dist\QuillMD-Setup-0.0.3.exe
```

`release.yml` 的 Windows job 已包含这一步；静默安装不能替代它，因为窗口进程崩溃时静默安装仍可能返回 0。

### 2.3 安全软件/路径拦截

同文件对照法：

1. 把安装器复制到普通目录，例如 `D:\Work\Downloads`；
2. 从普通目录双击；
3. 如果普通目录正常、原目录失败，问题在**路径/目录策略/安全软件**，不是安装包。

火绒的联网控制/应用控制可能对某个完整路径留下 `block=1`。处理：

- 优先在火绒界面把该安装器/QuillMD 加入允许，或删除对应拦截规则；
- 不要靠改文件名绕过安全软件；
- 长期使用固定、正常、可信的安装包目录（例如 `D:\Work\Downloads`）。

### 2.4 TEMP 真的不可用（较少见）

只有排除以上情况后才检查：

```powershell
$env:TEMP
Test-Path $env:TEMP
# 32 位进程写 TEMP
C:\Windows\SysWOW64\cmd.exe /d /c "echo ok > %TEMP%\wow64-test.tmp"
```

注意：从 Git Bash 启动 NSIS 时 `TEMP` 可能是 `/tmp`，NSIS 不认 POSIX 路径。请从 Explorer
或 PowerShell 启动，或把 `TEMP/TMP` 设为合法的 Windows 路径。

## 3. 安装器不识别旧版本

Windows NSIS 升级识别依赖卸载注册项，典型位置：

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{APP_GUID}
```

不是扫描磁盘找 `QuillMD.exe`。排查：

```powershell
Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' |
  ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if ($p.DisplayName -match 'QuillMD') {
      [pscustomobject]@{
        Key = $_.PSChildName
        Name = $p.DisplayName
        Location = $p.InstallLocation
        Uninstall = $p.UninstallString
      }
    }
  }
```

常见原因：

- 旧版本已经被卸载，注册项不存在：新安装器把它当全新安装，**这是正常行为**；
- 用户/测试脚本把旧安装目录删了，但没有通过卸载器清理注册项；
- 测试安装使用自定义 `/D=`，和正式安装路径不同；
- 自动化 GUI 测试点击了升级，触发旧 `old-uninstaller.exe`，随后脚本中断，留下半个卸载状态。

测试安装卫生：

- 自动测试使用独立的临时目录，例如 `D:\Work\QuillMD-test`；
- 不要对真实安装目录自动点击升级；
- 清理测试安装时使用它自己的 `Uninstall QuillMD.exe`，或记录并恢复注册项；
- 安装器自身不需要联网；安装器识别旧版本也不需要联网。

## 4. 应用内更新与网络

**安装器本身是离线 NSIS 包**：`app-64.7z` 已内嵌，没有 INetC/NSISDL，也没有
WinINet/WinHTTP/URLMON/WS2_32 网络导入。安装器不负责下载。

应用的自动网络：

- 应用启动时静默检查 CNB 更新（`update:check`）；
- 云同步只对用户配置的 S3/WebDAV 生效；
- 图床只在用户使用对应命令时访问；
- 文档中的远程图片按 Markdown 内容加载。

更新检查失败通常不是安装器问题。若设置页检查更新失败、返回 `ok:false`：

1. 确认 CNB 的 Git refs 和 `latest.yml` 可访问；
2. 检查火绒“网络防护/联网控制”是否拦截了 `QuillMD.exe`（新路径可能需要单独放行）；
3. 测试时使用独立 profile，避免单实例/残留进程影响。

应用启动更新检查只发 GET，带 `User-Agent: QuillMD-Updater`，不带 Cookie/请求体，
不上传文件内容、用户名或系统信息。下载时才请求安装器，并按 `latest.yml` 的 SHA-512 校验。

### 「下载的文件校验不一致」——SHA-512 编码不匹配（v0.0.3/v0.0.4 根因）

electron-builder 往 `latest*.yml` 里写的 `sha512` 是 **base64**；更新器对下载
的字节算出来的是 **hex** 摘要。v0.0.3/v0.0.4 的更新器把两个字符串直接比较，
永远不相等 —— 完整下载后必然报「下载的文件校验不一致，已删除」，与网络、
杀软无关（此前应用内更新走 GitHub digest `sha256:<hex>`，两边都是 hex，所以
没暴露）。三层修复（缺一不可）：

1. 客户端：`update-core.js` 的 `normalizeSha512()` 统一按 hex 比较（base64 /
   hex 都接受；无效值按「无校验信息」fail-closed），`expectedSha()` 使用它；
2. 发布链：`release.yml` 在上传前运行
   `node scripts/ci/normalize-latest-yml-sha512.mjs dist`，把 `latest*.yml`
   重写为小写 hex（脚本自带 base64→hex→base64 往返校验，坏值直接失败），
   这样**没有新客户端的老版本（≤ v0.0.4）也能通过应用内更新**；
3. 存量资产：v0.0.4 的三份 `latest*.yml` 用一次性工作流
   `fix-v0.0.4-latest-yml.yml` 重写并强制同步 CNB。

回归测试：

```bash
npm run test:update-core     # normalizeSha512 + 重写脚本（base64/hex/坏值）
npm run test:update-cnb-feed # 真实 updater.js 走 CNB 路径端到端：
                             # base64 SHA-512 必须校验通过，坏字节仍拒绝
```

`test:update-cnb-feed` 曾在还原旧比较逻辑时精确复现用户报错，确认测试有效。
排障提示：更新器检查失败只回 `ok:false`；把 `HORSEMD_TEST_UPDATE_CNB_SITE`
指到本地假 CNB 服务器即可在 1 分钟内复现整条链路，不必真发版。

### 安装完成页自动启动应用

electron-builder 的 assisted installer 默认在完成页提供“运行 QuillMD”，默认勾选。
如果安装完立即看到网络活动，通常是应用启动后的更新检查，不是安装器在联网。

安装时想完全离线：在完成页取消勾选“运行 QuillMD”。

## 5. 便携包与 Windows 兜底

Windows 发布同时提供：

```text
QuillMD-<version>-win-x64-portable.zip
```

解压后是 `QuillMD\QuillMD.exe`。用于：

- NSIS 安装器被本机策略拦截；
- 不想安装、不想写卸载注册项；
- 临时验证。

构建注意：

```bash
cd dist
7z a -tzip -mx=7 "QuillMD-${VERSION}-win-x64-portable.zip" QuillMD
```

务必在 `dist` 目录内压缩，否则 zip 根目录会多一层 `dist\QuillMD`。
在 Windows 的 `7z l` 输出里路径使用反斜杠，脚本检查根目录时先 `tr '\\' '/'`。

便携包不会创建卸载项/快捷方式；删除文件夹即卸载。

## 6. Release / CNB 同步

发布链：

1. `.github/workflows/release.yml`：矩阵构建 Windows/macOS/Linux；
2. Windows 打包前运行 `node scripts/ci/patch-nsis-system-plugin.mjs`；
3. Windows 产物包含 NSIS 安装器、blockmap、`latest.yml` 和 portable zip；
4. `scripts/ci/sync-cnb-release.mjs` 把 GitHub Release 资产同步到 CNB；
5. 应用更新源固定为 CNB，不使用 GitHub API。

踩坑记录：

- **不要依赖 `GITHUB_REF_NAME` 指定发布 tag**：GitHub Actions 会把它保留为分支名
  （例如 `main`），覆盖自定义值。使用自定义 `RELEASE_TAG`。
- 覆盖已存在的 CNB 资产时设置 `CNB_FORCE_SYNC=1`；只想同步部分资产时用
  `CNB_SYNC_ASSETS=name1,name2`。
- 一次性回填 v0.0.3 时，CNB 同步曾因为 `GITHUB_REF_NAME=main` 找不到 Release；
  根因就是上面的保留变量覆盖。
- 7z 在 Windows 上输出反斜杠路径，zip 内容检查不能只 grep `QuillMD/QuillMD.exe`。
- `latest.yml` 必须和实际上传的安装器 hash/size 一致；发布后从 CNB 下载安装器并核对 SHA-512。
- 不要在命令行参数里传 CNB token。安全软件/日志可能记录完整命令行；token 只放在 GitHub Actions Secret 中。
  如果曾在命令行暴露过 token，应轮换并更新 Secret。

发布后验证：

```powershell
# 从 CNB 下载 latest.yml 和安装器
# 核对 size 与 SHA-512
# 安装器首窗可打开
# 静默安装返回 0
```

## 7. 全盘低完整性目录排查

目标：找出哪些目录被标为 Low integrity，而不是逐个文件猜。

方法：

- 单目录：`icacls <dir>`；看 `Mandatory Label\Low Mandatory Level`。
- 批量：`icacls` 一次只接受一个路径的用法；批量调用时不要期待它处理多个参数。
- 需要读取 SACL/完整性标签但 `Get-Acl -Audit` 报 `SeSecurityPrivilege` 时，使用提升权限的
  PowerShell，或调用 Win32 `GetFileSecurity` 读取 SACL SDDL。
- `icacls` 输出里低标签可能是英文/本地化文本，尽量同时检查 `Low Mandatory Level` 和
  `S-1-16-4096`/`LW`。

经验：Windows 系统本身有大量正常的 Low 目录（`AppData\LocalLow`、AppContainer
`AppData\Local\Packages\*\AC`、`INetCache\Low`、`$Recycle.Bin`、Edge/Adobe/Lark 沙箱等）。
重点看**用户内容目录**是否出现 Low + 随机 `S-1-4-...` + `Everyone DENY` 的组合；
这通常意味着某个沙箱工具把该目录当成了 workspace。

不要因为“低完整性目录数量很多”就判断中毒；先分类标准系统目录和用户内容目录。

## 8. 安全检查清单

- [ ] 安装包 SHA-256/SHA-512 与 `latest.yml` 一致
- [ ] 7z 完整性测试通过
- [ ] 安装器内 `System.dll` 为 NSIS 3.13
- [ ] `multiUser.nsh` 已应用 `%LOCALAPPDATA%\Programs` 补丁（两个 patch 脚本都执行）
- [ ] 安装目录不是 Low integrity，且没有异常 capability/deny ACE
- [ ] 安装器首窗正常出现
- [ ] 静默安装返回 0（测试目录）
- [ ] 便携包解压后 `QuillMD\QuillMD.exe` 可启动
- [ ] 应用启动更新检查能从 CNB 读取 `latest.yml`
- [ ] 没有把 token 放进命令行、脚本或文档
- [ ] 测试安装已通过卸载器清理，或明确保留

## 9. 本次故障的结论

这次的实际根因分两层：

1. **DeepSeek Harness（Horus）的 workspace 沙箱**给 `Downloads`/`Desktop` 写入了
   Low integrity + capability SID + Everyone deny，导致安装器首窗前退出码 2；
2. 旧 NSIS 3.04 的 `System.dll` 在 Windows 11 build 26300 上还有另一个独立的首窗崩溃；
   修复版安装器已改用 NSIS 3.13 的 `System.dll`。
3. 即使使用 NSIS 3.13，`multiUser.nsh` 里的 `SHGetKnownFolderPath` `System::Call`
   仍会在首窗前崩溃；现已改为 `%LOCALAPPDATA%\Programs`，并由
   `patch-nsis-multiuser.mjs` 自动应用。

`Downloads` 路径被安全软件单独拦截、TEMP 设置、安装器下载等，都是容易误判的旁支。
排查时先看完整性和安装器字节，再看安全软件和网络。

## 10. 版本与仓库归零重置（2026-11-08）

QuillMD 曾以 0.0.1–0.0.4 快速迭代（含两次安装器修复和一次更新链路修复），
2026-11-08 决定将版本管理与发版历史整体重置：git 历史压成单个初始提交强推
GitHub + CNB，旧 `v0.0.x` tag / Release 删除，版本从 **v0.0.1** 重新起步，
CHANGELOG 改写为单个首发条目。经验要点：

- **先修复、后重置**：重置前先让 36c2dae（SHA-512 hex 修复）过 CI 并真实验证
  CNB `latest.yml` 已是 hex——被压缩进初始提交的代码必须是验证过的。
- **重置前的版本引用清理**：package/lock×2、guide 徽标（全部统一到新版本号）、
  截图目录改名（`images/v0.0.4/` → `images/v0.0.1/`，旧目录删除）、website、
  `llms.txt`、CHANGELOG、README（含英文页的 "Current stable release"）、
  fork 时代的 `docs/release-v*.md` 及其引用；一次性修复工作流
  （`portable-v0.0.3.yml`、`fix-v0.0.4-latest-yml.yml`）删除，
  但其修复逻辑已并入 `release.yml` 常规步骤。
- **强推与删 tag**：orphan 分支单提交 → `git push -f` 两个远程 →
  `git push --delete` 旧 tag。GitHub Release 资产删除用本地凭据调 API
  （`git credential fill` 取 token），CNB 同理；不把 token 写进任何文件。
- **归零的代价要明说**：已安装 0.0.3/0.0.4 的客户端不会把 v0.0.1 视为升级
  （版本号更小），只能手动重装一次；已有 clone 会与远程分叉，需重新克隆。
- **发布链照常**：新 `v0.0.1` tag 触发 Release workflow，`latest*.yml` 的
  hex 归一化步骤对新旧客户端都有效（见第 4 节）。
