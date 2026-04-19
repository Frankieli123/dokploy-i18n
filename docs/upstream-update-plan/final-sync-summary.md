# 最终收口总结

## 结论

当前这套分叉已经完成了从 `v0.27.0` 基线向上游 `v0.28.8` 的主干同步。  
结论不是“与 upstream 毫无差异”，而是：

- **主干结构已经大幅贴近 upstream**
- **高价值修复已基本吸收**
- **本地定制功能被保留并尽量隔离**
- **剩余差异大多是刻意保留的本地层或低收益微差异**

---

## 已完成的主线同步

### 版本线
已逐步审查并吸收：

- `v0.27.1`
- `v0.28.0`
- `v0.28.1`
- `v0.28.2`
- `v0.28.3`
- `v0.28.4`
- `v0.28.5`
- `v0.28.6`
- `v0.28.7`
- `v0.28.8`

### 高冲突基础设施
已完成主要对齐：

- 大依赖升级底座
  - Node 24 目标
  - pnpm 10
  - TRPC 11
  - better-auth 新版
- permissions / custom roles / audit logs
- SSO / trusted origins / trusted providers
- custom-role / sso 目录结构上游化
- OpenAPI 生成链恢复并稳定

### 应用层与 UI 主干
已完成主要对齐：

- Search API / UI 主干
- Deployments Dashboard / Queue 主干
- `project.all / projects.show` 多轮轻量化与结构收口
- settings / organization / session / notification 等主链同步

---

## 已完成的专题

### 1. patches
已打通：

- 数据表 / service / router
- UI
- 部署前应用
- Compose patches ordering 修复

当前判断：
- 已可用
- 核心能力已基本对齐 upstream

### 2. 通知系统
已完成：

- `volumeBackup` 事件接入
- 共享分发层第一阶段收口
- settings UI / schema / service 对齐

当前判断：
- 主干可用
- 高冲突新渠道未继续硬并

### 3. backup / restore 路径语义
已完成第一阶段兼容迁移：

- 新写入路径向 `appName/serviceName` 前缀靠拢
- 旧 flat 路径仍兼容
- restore 支持旧路径/新路径

当前判断：
- 已不是主干阻塞项
- 后续如继续推进，属于第二阶段优化

### 4. rollback / deployment cleanup
已完成：

- 低风险稳定性修复吸收
- 专题审查收口

当前判断：
- 剩余主要是 rollback 架构策略差异
- 不适合再机械同步

---

## 明确保留的本地定制层

这些不是“没对齐”，而是**必须保留**：

1. **AI / MCP / AI 面板**
2. **Git 独有设置**
3. **备份增强**
4. **项目卡片快捷域名入口**
5. **i18n**

原则上：
- 这些功能不能因为继续追 upstream 而被削弱
- 它们已经尽量被隔离成独立层，减少对主干同步的干扰

---

## 当前相对 upstream 还剩的差异

### 1. 刻意保留的差异
- 本地 AI / Git / 备份能力
- 项目卡片快捷域名入口
- i18n 相对 upstream 英文硬编码
- enterprise / license gate 不强绑定

### 2. 可继续做、但收益已经下降的差异
- Deployments 视觉与交互细节
- Search UI 细节
- `projects/show` 的少量展示细节

### 3. 不建议继续机械同步的差异
- rollback 镜像来源策略
- rollback 前 private registry login 架构选择
- 任何会把本地已开放能力重新收紧到 enterprise gate 的改动

---

## 当前验证状态

当前收口后的主验证链已经打通：

- `pnpm --filter=server run typecheck`
- `pnpm --filter=dokploy run typecheck`
- `pnpm --filter=dokploy run generate:openapi`

OpenAPI 当前稳定在：

- **484 endpoints**

---

## 对“是否继续”的建议

如果目标是：

### 继续尽可能跟 upstream
那现在最合理的方式已经不是大规模重构，而是：

- 按需做小规模低风险收口
- 遇到新 upstream 版本时继续逐版审查

### 保持当前状态
那现在也已经到了一个可以接受的阶段：

- 主干对齐度已经足够高
- 本地定制功能仍完整
- 剩余差异大多可接受

---

## 最终判断

这轮工作完成后，可以把当前分叉理解为：

> **一个主干已经明显贴近 Dokploy upstream、同时仍保留本地定制能力的稳定分叉。**

后续继续跟 upstream 的难度，已经明显低于最开始。  
继续推进时，不需要再用“大版本重构”的方式，更多是：

- 小步同步
- 专题判断
- 保住本地定制层
