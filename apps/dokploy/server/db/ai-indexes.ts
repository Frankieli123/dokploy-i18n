import postgres from "postgres";

type IndexCandidate = {
	existsAsAnyOf: string[];
	createSql: string;
};

const AI_INDEXES: IndexCandidate[] = [
	{
		existsAsAnyOf: [
			"ai_message_conversation_created_at_idx",
			"ai_message_conv_created_idx",
		],
		createSql:
			'CREATE INDEX CONCURRENTLY ai_message_conversation_created_at_idx ON ai_message ("conversationId", "createdAt");',
	},
	{
		existsAsAnyOf: [
			"ai_tool_execution_conversation_created_at_idx",
			"ai_tool_exec_conv_created_idx",
		],
		createSql:
			'CREATE INDEX CONCURRENTLY ai_tool_execution_conversation_created_at_idx ON ai_tool_execution ("conversationId", "createdAt");',
	},
	{
		existsAsAnyOf: ["ai_conversation_user_updated_at_idx"],
		createSql:
			'CREATE INDEX CONCURRENTLY ai_conversation_user_updated_at_idx ON ai_conversation ("organizationId", "userId", "status", "updatedAt");',
	},
];

async function indexExists(sql: postgres.Sql, name: string): Promise<boolean> {
	const rows = await sql<{ reg: string | null }[]>`
		select to_regclass(${name}) as reg
	`;
	return Boolean(rows[0]?.reg);
}

export async function ensureAiChatPerformanceIndexes(): Promise<void> {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) return;

	const sql = postgres(connectionString, { max: 1 });
	try {
		for (const candidate of AI_INDEXES) {
			const alreadyExists = await (async () => {
				for (const name of candidate.existsAsAnyOf) {
					if (await indexExists(sql, name)) return true;
				}
				return false;
			})();
			if (alreadyExists) continue;

			await sql.unsafe(candidate.createSql);
		}
	} catch (error) {
		console.error("Failed to ensure AI indexes:", error);
	} finally {
		await sql.end({ timeout: 5 }).catch(() => {});
	}
}

