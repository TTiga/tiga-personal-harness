---
description: "已退场的客户端注册：桌面账号登录面全部移除；组件树与多语言字典仅为各自测试保留编译。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-account

[English](README.md) | 中文

## 概述

客户端入口不再注册任何席位：桌面账号登录面——账号设置分区、侧栏账号菜单、账号登录引导行、账号额度提醒、原生平台页宿主——均已退场，各归属壳保留各自的非账号 fallback。包树保持编译：组件与多语言字典为其测试保留，入口保留这些文件使用的 `settings.account` 语言命名空间类型。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)

<a id="use-this-package"></a>
## 使用本包

仍列出本包的 roster 行照常挂载，但客户端在任何渲染器中都不贡献席位、不产生账号 Remote 流量。纯 Web 客户端本就不渲染这些席位；桌面 profile 另经启动器持有的 account-sweep overlay 整行禁用，因而不存在任何账号登录面。

<a id="model-experience"></a>
## 模型体验

无。账号凭据只影响 HTTP 认证，不进入模型提示词、Session 日志或工具结果。

#### KV Cache 影响

不改变任何模型请求前缀。

<a id="dev-note"></a>
### 开发备注

[桌面登录决策](../../../.agents/notes/implemented/architecture/2026-09-14-deepseek-account-login.zh.md) 记录了最初的取消与存储归属。桌面退场由启动器持有的 account-sweep overlay（`apps/desktop-host/src/index.ts`）实施，其 Web e2e 镜像由 `apps/desktop-host/tests/account-sweep.spec.ts` 锁定为字节一致。
