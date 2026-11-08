# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.0.1] - 2026-11-08

QuillMD 的第一个版本：一款温暖、独立的 Markdown 编辑器，代码线来自
杨庭毅 的 HorseMD（MIT，见 LICENSE 保留的原作者版权与致谢），
自此由本项目独立维护。版本管理与发布历史自本版本起重置。

### 编辑器

- 所见即所得实时预览（Milkdown Crepe / ProseMirror），源码模式切换保持阅读位置
- 多功能查找替换：区分大小写、全字匹配、正则（含多行与替换模板）、选区内查找
- 表格（单元格换行、自适应列宽、按需横滚、按住调宽）、代码块高亮与行号、
  LaTeX 公式、Mermaid 图表（全屏灯箱缩放）、任务列表、审阅标记（CriticMarkup）
- 原文保真保存：富文本只写回实际修改位置，不规范化未触碰的 Markdown
- 纯文本 `.txt` 秒开、文档位置记忆、富文本复制、原生 HTML 表格渲染
- PDF 导出中心（分页预览、纸张/边距/页眉页脚/目录/书签）与 HTML 导出中心、
  Pandoc 文档转换（Word/EPUB/LaTeX 等）

### 工作区与效率

- 单窗口多标签 + 分屏 + 源码/预览双栏；文件树工作区（拖拽移动、外部文件夹拖入）
- 大纲面板与悬浮章节导航、命令面板、自定义快捷键、可组合自定义 CSS、六套主题
- 会话恢复、未保存草稿不丢、外部改动监听与冲突提示

### 云同步与离线

- 云同步文件夹：WebDAV / S3 兼容存储，上传、下载、加入、双向同步与冲突保留
- **严格离线模式**：一键完全断网——更新检查/下载、云同步、图床上传、远程
  图片/媒体/iframe、导出抓图、外部链接全部停用；开关由主进程权威持久化，
  开启瞬间中断进行中的同步与下载；本地写作与离线导出不受影响

### 发布与更新链路

- GitHub Actions 三平台自动构建（Windows NSIS + portable zip、macOS dmg/zip
  arm64+x64、Linux deb + Arch 包），tag 触发自动发布并镜像到 CNB Release
- 应用内更新完全走 CNB（国内直连）：tag 发现 → `latest*.yml` 元数据 → 下载并
  校验 SHA-512；`latest*.yml` 在上传前统一重写为小写 hex（带往返校验），
  base64/hex 客户端均可校验
- Windows 安装器修复 NSIS 3.04 `System.dll` 与 `multiUser.nsh` known-folder
  两层启动崩溃（补丁进构建链与 CI），发布前自动做安装器首窗冒烟测试
- 详细的安装 / 更新 / 发布故障排查经验沉淀在 [SOP.md](./SOP.md)

### 已知边界

- 安装包未购买签名：Windows SmartScreen / macOS Gatekeeper 首次启动需手动放行
