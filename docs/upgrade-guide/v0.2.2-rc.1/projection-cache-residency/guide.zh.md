---
kind: upgrade-guide
description: "`@deepseek-ai/dsh-session-projection-cache` 需要两个新的配置字段：`startupMaxAgeDays` 与 `maxResidentRecords`。"
---

# 投影缓存的启动窗口与内存上限

[English](guide.md) | 中文

## 变更

此前，投影缓存在启动时把 `storages/session_projcache/sessions/` 下所有存储的记录读进内存，其配置只有 `writeEveryEvents` 与 `writeIntervalMs`。

现在启动只读取最近 `startupMaxAgeDays` 天内改动过的最新记录，最多 `maxResidentRecords` 条；之后内存中最多保留 `maxResidentRecords` 条完整记录。两个字段都是必填。随附的 `base` bundle 把它们设为 `30` 与 `300`，所以随附的 profile 不需要改动。自定义的 `cordis.yml` 或补丁若整块写出 `session-projection-cache` 条目的 `config` 而缺这两个字段，会在加载时通不过配置校验。存储的记录和 Session 日志格式不变。

## 迁移

1. 在你自己的 `cordis.yml` 文件和补丁里搜索条目 `id: session-projection-cache` 或名称 `@deepseek-ai/dsh-session-projection-cache`。
2. 在找到的每个 `config` 块中，把两个字段加在现有字段旁边：

   ```yaml
   config:
     writeEveryEvents: 200
     writeIntervalMs: 5000
     startupMaxAgeDays: 30
     maxResidentRecords: 300
   ```

3. 直接挂载插件的代码，例如测试或内嵌宿主中的 `ctx.plugin(SessionProjectionCache, config)`，也要传入这两个字段。
4. 启动宿主。没有出现 `session-projection-cache` 的配置错误即迁移成功；字段含义见[包 README](../../../../packages/session/session-projection-cache/README.zh.md)。
