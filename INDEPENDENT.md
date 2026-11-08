# 独立维护说明

本项目基于 杨庭毅 的 HorseMD（MIT 协议）独立维护，保留原作者版权与许可证声明；现为独立项目，不与原仓库同步或合并。

## 已切断的本地上游关系

- 已清除 git `origin` remote、远程跟踪分支与 `branch.main` 上游配置。
- 已移除 `package.json` 的 repository/homepage/bugs 与 electron-builder GitHub publish。
- 应用内更新默认不联网；只有显式测试 feed 才能启用，Release workflow 默认 `--publish never`。
- 官网、教程、设置页、状态栏、诊断报告不再打开原作者仓库、站点、Issue、微信或统计脚本。
- `LICENSE` 原样保留；`docs/` 与 `CHANGELOG.md` 中的历史链接仅作为来源记录。

## GitHub 网页上的 Fork 标签

GitHub 的 “forked from” 是服务器端关系，修改本地 git remote 不能清除它。如需网页上也不显示 Fork，请在 GitHub 仓库 Settings → Danger Zone 中脱离 fork 网络，或把代码导入新建的独立仓库；这两步需要仓库管理员操作，且会影响 star/fork/Issue 关系。

## 名称与图标

- 产品名：QuillMD；包名 `quillmd`；appId `com.quillmd.app`。
- 图标为自绘 QuillMD 羽毛笔标识（暖纸底 + 墨色 + 陶土笔尖），不使用原项目马/马头品牌元素。
- 云同步远端前缀 `HorseMD/` 是历史数据协议标识，为兼容既有云端工作区保留，不作为品牌露出。
