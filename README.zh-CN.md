<p align="center"><img src="assets/cinderdeck-icon.png" width="128" alt="Cinderdeck" /></p>

# Cinderdeck

**macOS 上的开发控制台。**

Cinderdeck 是一款原生 Mac 应用，将项目、服务和开发工具集中管理。你可以把任意一组文件夹或代码仓库配置成一个 stack，为各项服务指定启动命令，再通过应用、终端或编程代理控制它们。

- 使用 TOML 配置项目、环境变量、钥匙串引用、服务依赖和就绪检查。
- 启动、停止、重启服务；查看日志、端口、进程归属和代理活动。
- 查看 Git 状态，切换分支时明确选择暂存或保留本地修改。
- 通过 `cinderdeck` CLI 和本地 MCP 服务连接 Codex、Cursor、Claude Code 等客户端。
- 保留本地文本剪贴板历史，以及截图、录屏、标注、OCR 和视频编辑功能。

## 开始使用

从源码构建需要 **Xcode 26.2 或更高版本**，应用支持 macOS 13 及以上。打开 `Cinderdeck.xcodeproj`，选择 **Cinderdeck** scheme。参阅[构建指南](docs/BUILD.md)。

在应用中打开 **⌘⇧H → Stacks → Create stack**，选择自己的文件夹和命令。默认配置目录为 `~/.config/cinderdeck/stacks/`。不限定仓库、框架或语言；保存配置不会自动启动服务。

```sh
/Applications/Cinderdeck.app/Contents/MacOS/Cinderdeck stacks install-cli
cinderdeck stacks status
cinderdeck stacks setup-agents --print
```

Release 版首次启动时会复制定制版 Snapzy 的本地数据，保留原件，并且不覆盖现有 Cinderdeck 数据。macOS 可能要求为新应用重新授予权限。参阅[迁移说明](docs/MIGRATION.md)。

Cinderdeck 从 **1.0.0 (200)** 开始独立版本。正式版会通过 Cinderdeck 的签名更新源自动更新（Debug 构建除外）。Snapzy 的 Homebrew 包和发布文件不适用于 Cinderdeck。

## 致谢

Cinderdeck 由 [Ryan Cardin](https://github.com/RyanCardin15) 维护，是 **[Snapzy](https://github.com/duongductrong/Snapzy) 的独立分支**。原项目由 **Trong Duong Duc 及其贡献者**创建，提供了截图、录屏和编辑功能的基础。原始 [BSD 3-Clause 许可证](LICENSE)及[署名信息](NOTICE)均予以保留。本项目并非 Snapzy 官方发布版本。

[English 与完整文档](README.md) · [Stacks](docs/STACKS.md) · [报告 Cinderdeck 问题](https://github.com/RyanCardin15/Cinderdeck/issues)
