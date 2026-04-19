# Rollback / Deployment Cleanup 专题

## 当前状态
- 状态：已完成审查
- 结论：低风险高价值项基本已吸收，剩余差异主要是刻意保留的本地 rollback 策略

## 已对齐

### deployment cleanup
- `removeDeployment` 对缺失 deployment 返回 `null`
- 日志路径清理增加空路径保护
- `removeLastTenDeployments` 增加逐项错误隔离
- 远端清理命令增加空命令保护

### rollback 清理
- `deleteRollbackImage` 的 `execAsyncRemote(serverId, command)` 参数顺序已修正

### 相关交互
- deployment webhook 复制交互已同步
- watch paths tooltip/button 小修已同步

## 审查后未继续机械同步的部分

### 1. rollback 前 docker login
上游某阶段引入过 private registry 的 docker login 预热，但当前本地 rollback 仍采用：
- 先创建本地 rollback image tag
- 再按现有 `authConfig` 更新 service

这和 upstream 一度出现的 `rollbackRegistry + registry tag` 方案并不同构。

当前判断：
- 直接机械并入会改动 rollback 镜像语义
- 风险高于收益
- 暂保留本地策略

### 2. rollback image 生成策略
本地目前仍保留：
- `createRollbackImage(...)`
- `appName:vN` 本地镜像回滚链

这和 upstream 某些阶段的“按 registry full tag 回滚”不同。

当前判断：
- 这是本地现有 rollback 机制的关键部分
- 暂不改

## 影响评估
- 不影响 AI 面板
- 不影响 Git 独有设置
- 不影响备份增强

## 已验证
- `pnpm --filter=server run typecheck`
- `pnpm --filter=dokploy run typecheck`
- `pnpm --filter=dokploy run generate:openapi`

## 总结
这个专题当前已经没有明显值得继续机械同步的低风险项。  
剩余差异主要属于：
- rollback 镜像来源策略
- private registry 认证策略

它们都更像“架构选择差异”，不是简单补丁项。
