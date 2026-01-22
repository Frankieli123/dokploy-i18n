import { toolRegistry } from "./registry";
import type { Tool } from "./types";

export type ToolIntent =
	| "query"
	| "application"
	| "backup"
	| "database"
	| "domain"
	| "github"
	| "server";

export type ToolSelectionContext = {
	projectId?: string;
	serverId?: string;
	minTools?: number;
	maxTools?: number;
};

const DB_PREFIXES = [
	"database_",
	"postgres_",
	"mysql_",
	"mariadb_",
	"mongo_",
	"redis_",
] as const;

function classifyIntent(messageLower: string): ToolIntent {
	const isBackupRequest =
		/(backup|restore|snapshot)/i.test(messageLower) ||
		/(备份|恢复|还原)/i.test(messageLower);
	const isVolumeBackupRequest =
		/(volume[_\s-]?backup|volume\s+backup|volume-backup|volume_backup|dokploy_all_mounts|mount|volumes?\b|s3|minio|destination|bucket|cron|keep(latest)?count)/i.test(
			messageLower,
		) || /(挂载|卷|对象存储|minio|定时)/i.test(messageLower);

	if (isBackupRequest && isVolumeBackupRequest) {
		return "backup";
	}

	if (
		/(postgres|mysql|mariadb|mongo|mongodb|redis|database|db\b|schema|query|migration)/i.test(
			messageLower,
		)
	) {
		return "database";
	}
	if (
		/(github|git hub|repo|repository|\bpr\b|pull request|branch|commit|仓库|分支|提交|拉取请求|合并请求)/i.test(
			messageLower,
		)
	) {
		return "github";
	}
	if (
		/(traefik|proxy|gateway|routing|router|reverse\s*proxy)/i.test(
			messageLower,
		) ||
		/(\u53cd\u4ee3|\u53cd\u5411\u4ee3\u7406|\u4ee3\u7406|\u8f6c\u53d1|\u7f51\u5173|\u8def\u7531)/i.test(
			messageLower,
		)
	) {
		return "server";
	}
	if (
		/(domain|dns|subdomain|hostname|ssl|tls|https|certificate|cert|let'?s encrypt)/i.test(
			messageLower,
		)
	) {
		return "domain";
	}
	if (
		/(server|host|node\b|cpu|memory|ram|disk|ssh|docker|daemon|uptime|load)/i.test(
			messageLower,
		)
	) {
		return "server";
	}
	if (
		/(app|application|deploy|deployment|build|restart|logs|compose|container|service)/i.test(
			messageLower,
		)
	) {
		return "application";
	}
	if (/(数据库|迁移)/i.test(messageLower)) {
		return "database";
	}
	if (isBackupRequest) {
		return "database";
	}
	if (/(域名|证书|ssl|https)/i.test(messageLower)) {
		return "domain";
	}
	if (/(服务器|主机|cpu|内存|磁盘|docker)/i.test(messageLower)) {
		return "server";
	}
	if (/(应用|部署|重启|日志|容器|服务|compose)/i.test(messageLower)) {
		return "application";
	}
	return "query";
}

function detectDatabasePrefixes(messageLower: string): string[] {
	const prefixes: string[] = [];
	if (/(postgres|postgresql|\bpg\b)/i.test(messageLower))
		prefixes.push("postgres_");
	if (/(mysql)/i.test(messageLower)) prefixes.push("mysql_");
	if (/(mariadb)/i.test(messageLower)) prefixes.push("mariadb_");
	if (/(mongo|mongodb)/i.test(messageLower)) prefixes.push("mongo_");
	if (/(redis)/i.test(messageLower)) prefixes.push("redis_");
	return prefixes;
}

function wantsDatabaseWriteOperation(
	messageLower: string,
	userMessage: string,
): boolean {
	return (
		/(create|add|new|deploy|start|provision|setup|install|init)/i.test(
			messageLower,
		) || /(创建|新建|新增|部署|启动|安装|开通|初始化)/i.test(userMessage)
	);
}

function wantsDatabaseDeleteOperation(
	messageLower: string,
	userMessage: string,
): boolean {
	return (
		/(delete|remove|destroy)/i.test(messageLower) ||
		/(删除|移除|销毁)/i.test(userMessage)
	);
}

function scoreTool(tool: Tool, messageLower: string): number {
	const nameLower = tool.name.toLowerCase();
	const [ns = "", ...rest] = nameLower.split("_");
	const verbs = new Set([
		"list",
		"get",
		"find",
		"create",
		"update",
		"delete",
		"remove",
		"deploy",
		"start",
		"stop",
		"restart",
		"run",
		"restore",
		"status",
		"retry",
		"cancel",
		"tail",
	]);
	const action = rest.find((p) => verbs.has(p)) ?? rest[0] ?? "";
	let score = 0;

	if (messageLower.includes(ns)) score += 8;
	if (action && messageLower.includes(action)) score += 4;
	if (tool.riskLevel === "low") score += 2;
	if (tool.requiresApproval) score -= 2;

	if (/(list|show|all|overview)/i.test(messageLower) && action === "list")
		score += 3;
	if (/(details|info|get|inspect)/i.test(messageLower) && action === "get")
		score += 3;
	if (/(create|add|new)/i.test(messageLower) && action === "create") score += 2;
	if (/(deploy|start|run)/i.test(messageLower) && action === "deploy")
		score += 2;
	if (/(delete|remove|destroy)/i.test(messageLower) && action === "delete")
		score -= 3;

	return score;
}

function rankTools(tools: Tool[], messageLower: string): Tool[] {
	return [...tools].sort((a, b) => {
		const diff = scoreTool(b, messageLower) - scoreTool(a, messageLower);
		if (diff !== 0) return diff;
		return a.name.localeCompare(b.name);
	});
}

function uniqueByName(tools: Tool[]): Tool[] {
	const seen = new Set<string>();
	const out: Tool[] = [];
	for (const t of tools) {
		if (seen.has(t.name)) continue;
		seen.add(t.name);
		out.push(t);
	}
	return out;
}

export function selectRelevantTools(
	userMessage: string,
	context: ToolSelectionContext = {},
): Tool[] {
	const messageLower = userMessage.toLowerCase();
	const intent = classifyIntent(messageLower);
	const minTools = context.minTools ?? (intent === "query" ? 0 : 15);
	const maxTools = context.maxTools ?? (intent === "query" ? 12 : 25);
	const wantsTraefik =
		/(traefik|proxy|gateway|routing|router|reverse\s*proxy)/i.test(
			messageLower,
		) ||
		/(\u7f51\u5173|\u8def\u7531|\u53cd\u5411\u4ee3\u7406|\u53cd\u4ee3|\u4ee3\u7406|\u8f6c\u53d1|\u52a0\u901f)/i.test(
			userMessage,
		);
	const wantsReverseProxySetup = wantsTraefik;
	const prefixes = new Set<string>();
	if (intent !== "query") {
		prefixes.add("project_");
		prefixes.add("environment_");
	}

	if (intent === "query") {
		if (/(project|projects|项目)/i.test(messageLower)) prefixes.add("project_");
		if (/(environment|env\b|环境)/i.test(messageLower))
			prefixes.add("environment_");
		if (/(server|servers|服务器)/i.test(messageLower)) prefixes.add("server_");
		if (/(database|db\b|数据库)/i.test(messageLower)) prefixes.add("database_");
		if (/(backup|restore|备份|恢复)/i.test(messageLower)) {
			prefixes.add("backup_");
			prefixes.add("volume_backup_");
			prefixes.add("destination_");
			prefixes.add("mount_");
		}
		if (wantsTraefik) prefixes.add("traefik_");
	}

	if (
		intent === "query" &&
		/(github|git hub|repo|repository|\bpr\b|pull request|branch|commit|仓库|分支|提交|拉取请求|合并请求)/i.test(
			messageLower,
		)
	) {
		prefixes.add("github_");
		prefixes.add("git_provider_");
	}

	if (context.serverId && (intent === "server" || intent === "application")) {
		prefixes.add("server_");
	}

	if (intent === "application") {
		prefixes.add("application_");
		prefixes.add("compose_");
	}

	if (intent === "github") {
		prefixes.add("github_");
		prefixes.add("git_provider_");
	}

	if (intent === "backup") {
		prefixes.add("backup_");
		prefixes.add("volume_backup_");
		prefixes.add("destination_");
		prefixes.add("mount_");
		prefixes.add("application_");
		prefixes.add("compose_");
	}

	if (intent === "server") {
		prefixes.add("server_");
		if (wantsTraefik) prefixes.add("traefik_");
	}

	if (wantsReverseProxySetup) {
		prefixes.add("domain_");
		prefixes.add("certificate_");
		prefixes.add("compose_");
		prefixes.add("application_");
	}

	let restrictDbToLowRisk = false;
	const dbWriteOp =
		intent === "database" &&
		wantsDatabaseWriteOperation(messageLower, userMessage);
	const dbDeleteOp =
		intent === "database" &&
		wantsDatabaseDeleteOperation(messageLower, userMessage);
	if (intent === "database") {
		prefixes.add("database_");
		const dbPrefixes = detectDatabasePrefixes(messageLower);
		if (dbPrefixes.length > 0) {
			for (const p of dbPrefixes) prefixes.add(p);
		} else {
			for (const p of DB_PREFIXES) prefixes.add(p);
			restrictDbToLowRisk = !dbWriteOp;
		}
	}

	if (intent === "domain") {
		prefixes.add("domain_");
		prefixes.add("certificate_");
	}

	const all = toolRegistry.getAll();
	let selected = all.filter((t) => {
		const matched = [...prefixes].some((p) => t.name.startsWith(p));
		if (!matched) return false;

		if (intent === "database" && !dbDeleteOp) {
			const action = t.name.toLowerCase().split("_")[1] || "";
			if (action === "delete" || action === "remove" || action === "destroy") {
				return false;
			}
		}

		if (restrictDbToLowRisk && t.category === "database") {
			const action = t.name.toLowerCase().split("_")[1] || "";
			return t.riskLevel === "low" || action === "list" || action === "get";
		}
		return true;
	});

	selected = rankTools(selected, messageLower);

	// Fill up to minTools with low-risk tools
	if (minTools > 0 && selected.length < minTools) {
		const extraPool = all.filter(
			(t) => !selected.some((s) => s.name === t.name),
		);
		const lowRisk = extraPool.filter(
			(t) => t.riskLevel === "low" && !t.requiresApproval,
		);
		selected = selected.concat(rankTools(lowRisk, messageLower));
	}

	// Still not enough? Add more tools
	if (minTools > 0 && selected.length < minTools) {
		const extraPool = all.filter(
			(t) => !selected.some((s) => s.name === t.name),
		);
		selected = selected.concat(rankTools(extraPool, messageLower));
	}

	selected = uniqueByName(selected).slice(0, maxTools);
	return selected;
}
