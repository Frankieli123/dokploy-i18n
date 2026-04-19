# Backup / Restore 路径语义专题

## 当前状态
- 状态：已完成第一阶段兼容迁移
- 目标：尽量对齐 upstream 的 `appName/serviceName` 前缀路径，同时不破坏现有备份与恢复

## 本轮已落地

### 1. 新备份写入路径向 upstream 靠拢
- 数据库备份现在写入：
  - `appName/<prefix>/<timestamp>.sql.gz`
- Compose 备份现在写入：
  - `composeAppName_serviceName/<prefix>/<timestamp>.sql.gz`
- Volume 备份现在写入：
  - `serviceAppName/<prefix>/<backup>.tar`

### 2. 保留旧路径兼容
- backup retention 同时扫描：
  - 新路径
  - 旧 flat 路径
- 删除旧文件时按文件精确路径删除，不会误删目录

### 3. Restore 兼容修复
- Compose restore 现在会把 `backupFile` 传给 restore command
- Mongo restore 现在补上 `--drop`
- Volume restore UI 现在能识别：
  - 旧 flat 路径
  - 新增的 `appName/...` 路径

## 影响评估
- 不影响 AI 面板
- 不影响 Git 独有设置
- 不削弱现有备份增强
- 标准镜像升级路径下，迁移仍由启动链自动执行

## 已验证
- `pnpm --filter=server run typecheck`
- `pnpm --filter=dokploy run typecheck`
- `pnpm --filter=dokploy run generate:openapi`

## 后续仍可继续做
1. 备份文件选择 UI 进一步按服务自动聚焦新路径
2. 对旧路径对象做更细的可视化迁移提示
3. 如果后面要继续贴 upstream，可再评估是否做“写新路径 + 后台迁移旧对象”专题
