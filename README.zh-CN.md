# Simple Memo

[English](README.md)

一个 Obsidian 本地便签插件。便签保存在 Markdown 文件中，无需账号或订阅。

![Simple Memo 演示界面](docs/screenshots/simple-memo.png)

## 功能

- 快速记录、Markdown 预览、草稿自动保存
- 标签、搜索、日期筛选、日历和热力图
- 待办、置顶、归档、回收站
- 图片和文件附件、随机回顾
- 标签与链接补全、组合筛选与保存、批量复制

## 安装

需要 Obsidian 1.7.2 或更新版本。

1. 下载并解压 [安装包](https://github.com/bitxinyu/obsidian-simple-memo/releases/latest)。
2. 将 `simple-memo` 文件夹放入笔记库的 `.obsidian/plugins/` 目录。
3. 重启 Obsidian，在「设置 → 第三方插件」中启用 **Simple Memo**。

更新时关闭插件，覆盖安装包中的文件，再重新启用。

## 使用

点击左侧便签图标，或在命令面板中选择 **Simple Memo: 打开便签**。输入内容后点击「记录」，也可以按 **⌘ / Ctrl + Enter** 保存。

正文中可以添加 `#标签`，保存前勾选「待办」可创建任务。主输入框支持粘贴、拖入图片和文件，也可以点击附件按钮添加。

顶部工具栏用于搜索和筛选；便签右上角的「…」菜单提供编辑、复制、置顶、归档和删除操作。误删的便签可以在「回收站」恢复。

命令面板还提供「快速记录」和「将选中文本复制为便签」，可在 Obsidian 设置中绑定快捷键。

在「设置 → Simple Memo」可选择日记（默认）、单文件或每条便签独立成篇，对应的默认位置是 `Journal/`、`memo.md` 和 `Memo/`。切换方式只影响新便签。

## Thino 兼容

新便签默认使用 `[!memo]` 和 `memoType`。已有 Thino 便签可直接读取和编辑，写回时沿用原格式。

要与原版 Thino 共用新便签，可在设置中导入 Thino 的存储位置。

## 其他说明

- 便签正文保存在 Markdown 文件中。备份或迁移时，如需保留草稿、回收站和已保存的筛选，请同时保留 `.obsidian/plugins/simple-memo/data.json`。
- 同步使用笔记库现有的同步方案，插件不提供同步服务。
- 已在 macOS、Obsidian 1.14.4 上验证。保留移动端支持，移动设备及多设备同时编辑尚未实机验证。
- 独立实现，与 Thino 无隶属关系。
- 开源协议：[MIT](LICENSE)。
