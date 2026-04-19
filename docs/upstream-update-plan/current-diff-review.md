# 当前相对 Upstream 的整体差异回顾

## 基线说明
- 当前本地版本线已逐步审查并吸收到 `v0.28.8`
- 目标不是“零差异”，而是：
  1. 保住本地定制功能
  2. 主干结构尽量贴近 upstream
  3. 剩余差异尽量收敛为薄兼容层

---

## 1. 必须保留的本地定制层

这些不是遗漏，而是当前项目明确需要长期保留的能力。

### 1.1 AI / MCP / AI 面板
- `apps/dokploy/components/dashboard/ai-assistant/*`
- `apps/dokploy/server/ai/*`
- `packages/server/src/utils/ai/*`

说明：
- 这是本地最核心的差异化能力之一
- 已完成与新 auth / settings / trpc 底座的兼容
- 后续不应为了追 upstream 而回退

### 1.2 Git 独有设置与 Provider 增强
- `apps/dokploy/components/dashboard/settings/git/*`
- application / compose 的 git provider 表单增强
- provider internal URL / setup 流程兼容

说明：
- 保留本地更强的可用性
- 结构可继续向 upstream 靠拢，但功能不应削弱

### 1.3 备份增强
- `packages/server/src/utils/backups/*`
- `packages/server/src/utils/restore/*`
- `packages/server/src/utils/volume-backups/*`
- `components/dashboard/application/volume-backups/*`
- `components/dashboard/database/backups/*`

说明：
- 包括 volume backup、通知容错、restore 兼容、路径语义兼容
- 允许继续向 upstream 对齐，但不能打掉现有增强

### 1.4 项目卡片快捷域名入口
- `apps/dokploy/components/dashboard/projects/project-quick-links.tsx`

说明：
- 已被隔离为独立本地层
- 不再阻碍 `projects/show.tsx` 主体继续对齐 upstream

---

## 2. 已经对齐得比较充分的区域

这些区域继续深挖的收益已经明显下降。

### 2.1 权限 / Custom Roles / Audit Logs
- 权限基建、角色解析、custom role 管理、审计日志主干已大幅对齐
- 剩余更多是 enterprise / license 限制，不是通用能力缺口

### 2.2 SSO / Trusted Origins / Trusted Providers
- 底层、设置页、登录入口已打通
- 剩余更多是 enterprise / 更深权限模型

### 2.3 Search
- Search API 已建
- Search UI 已接入
- 对旧重型接口依赖已显著降低

### 2.4 Deployments Dashboard / Queue
- 已有中央页
- 列表与队列主流程已成型
- SSR 权限检查也已向 upstream 收口
- 剩余多为细节精修与本地 i18n 差异

### 2.5 版本线主干同步
- `v0.27.1 -> v0.28.8` 已逐步审过
- 可直接吸收的高价值项基本已落地

---

## 3. 已完成但仍保留为“本地策略差异”的专题

### 3.1 Backup / Restore 路径语义
专题文档：
- `docs/upstream-update-plan/topics/backup-restore-path-semantics.md`

当前状态：
- 第一阶段兼容迁移已完成
- 新备份写入路径已向 upstream 的 `appName/serviceName` 前缀对齐
- 旧 flat 路径仍保留兼容
- restore 已兼容旧路径与新路径

结论：
- 这块现在不再是主干阻塞
- 若后续继续推进，属于“后台迁移旧对象/进一步收口”的第二阶段优化

### 3.2 Rollback / Deployment Cleanup
专题文档：
- `docs/upstream-update-plan/topics/rollback-deployment-cleanup.md`

当前状态：
- 低风险高价值项基本已吸收
- 剩余差异主要是 rollback 镜像来源策略、private registry 认证策略

结论：
- 这块剩下的是架构选择差异，不是简单补丁项
- 暂不建议机械继续同步

---

## 4. 后续仍值得继续同步的区域

### 4.1 `project.all` / `projects.show` 继续瘦身
相关文件：
- `apps/dokploy/server/api/routers/project.ts`
- `apps/dokploy/components/dashboard/projects/show.tsx`

当前状态：
- 已明显轻量化
- 快捷域名入口已拆出
- 权限判断已进一步向 upstream 收口
- 剩余差异更多是 `environment.isDefault` 缺位带来的本地选择逻辑与少量 UI 微差异

### 4.2 Deployments 视觉与交互精修
相关文件：
- `apps/dokploy/pages/dashboard/deployments.tsx`
- `apps/dokploy/components/dashboard/deployments/*`

当前状态：
- 主流程已具备
- 仍有一些展示与交互细节可继续贴近 upstream

### 4.3 Search UI 细节精修
相关文件：
- `apps/dokploy/components/dashboard/search-command.tsx`

当前状态：
- API 与主流程已对齐
- 剩余更多是分组、排序、空态、交互微差异

---

## 5. 明确可接受的微小差异

### 5.1 本地 i18n 与 upstream 英文硬编码
- 本地继续保留多语言
- 不建议为了“像 upstream”而回退到英文硬编码

### 5.2 视觉与交互微差异
- 按钮位置
- tooltip 行为
- 某些空态文案
- 某些表格列顺序

结论：
- 可以继续精修
- 但对“后续更容易跟 upstream”的收益已经较低

### 5.3 package / workflow / docs 层差异
- README / Dockerfile / workflow / docs 仍有差异
- 多数属于 fork 运行方式与发布习惯差异

---

## 6. Enterprise / Proprietary 相关差异

当前策略：
- 尽量同步 upstream 结构
- 但不把当前已开放能力重新收紧为 license / enterprise gate

涉及：
- whitelabeling
- license key
- enterprise-only resources
- 某些 proprietary router/feature gate

结论：
- 当前保持“结构贴近 upstream，限制不强绑定商业门槛”是合理策略

---

## 7. 总结判断

### 当前已经达到的状态
当前分叉相对 upstream，已经不是“两套完全不同的系统”，而是：
- 主干结构大幅靠近 upstream
- 高价值修复大面积吸收
- 本地定制功能被尽量隔离成独立层

### 当前最值得继续投入的方向
如果继续投入，建议优先级是：
1. `deployments` 视觉与交互精修
2. `search` UI 细节精修
3. `project.all / projects.show` 的最后一点视觉与选择逻辑收口

### 当前不建议优先投入的方向
1. 为了“看起来更像 upstream”去删除本地定制层
2. 机械抹平所有微小 UI 差异
3. 提前引入 enterprise / license 限制来换结构一致

## ???? 2026-04-18
- Search UI ????????? `extractServices` ????????????
- `deployments` ???? SSR ?????????????????????

- `project.all` ????? `organizationId / env`?????? upstream ????????

- `environment.isDefault` ?????????????????????? upstream ???
