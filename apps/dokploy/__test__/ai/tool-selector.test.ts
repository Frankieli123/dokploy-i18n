import { initializeTools, toolRegistry } from "@dokploy/server/services/ai-tools";
import { selectRelevantTools } from "@dokploy/server/services/ai-tools/selector";
import { describe, expect, it } from "vitest";

describe("AI tool selector", () => {
	initializeTools();

	it("registers trpc_procedure_suggest", () => {
		expect(toolRegistry.get("trpc_procedure_suggest")).toBeTruthy();
	});

	it("always includes core discovery tools", () => {
		const names = selectRelevantTools("backup all projects", { maxTools: 10 }).map(
			(t) => t.name,
		);
		expect(names).toContain("projects_inventory");
		expect(names).toContain("trpc_procedure_search");
		expect(names).toContain("trpc_procedure_describe");
		expect(names).toContain("trpc_procedure_call");
	});

	it("includes container inventory tools when relevant", () => {
		const names = selectRelevantTools("list containers for project", {
			maxTools: 10,
		}).map((t) => t.name);
		expect(names).toContain("project_containers");
	});

	it("includes SQL tools when relevant", () => {
		const names = selectRelevantTools("执行 SQL 改表", { maxTools: 10 }).map(
			(t) => t.name,
		);
		expect(names).toContain("database_sql_execute");
	});
});
