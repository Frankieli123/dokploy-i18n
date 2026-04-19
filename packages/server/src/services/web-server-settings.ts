import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import { member, webServerSettings } from "../db/schema";

export const getWebServerSettings = async () => {
	const settings = await db.query.webServerSettings.findFirst({
		orderBy: [asc(webServerSettings.createdAt)],
	});

	if (settings) {
		return settings;
	}

	const owner = await db.query.member.findFirst({
		where: eq(member.role, "owner"),
		with: {
			user: true,
		},
		orderBy: [asc(member.createdAt)],
	});

	const [created] = await db
		.insert(webServerSettings)
		.values({
			serverIp: owner?.user.serverIp ?? null,
			certificateType: owner?.user.certificateType ?? "none",
			https: owner?.user.https ?? false,
			host: owner?.user.host ?? null,
			additionalHosts: owner?.user.additionalHosts ?? [],
			letsEncryptEmail: owner?.user.letsEncryptEmail ?? null,
			sshPrivateKey: owner?.user.sshPrivateKey ?? null,
			enableDockerCleanup: owner?.user.enableDockerCleanup ?? false,
			logCleanupCron: owner?.user.logCleanupCron ?? "0 0 * * *",
			metricsConfig: owner?.user.metricsConfig,
			cleanupCacheApplications: owner?.user.cleanupCacheApplications ?? false,
			cleanupCacheOnPreviews: owner?.user.cleanupCacheOnPreviews ?? false,
			cleanupCacheOnCompose: owner?.user.cleanupCacheOnCompose ?? false,
		})
		.returning();

	return created;
};

export const updateWebServerSettings = async (
	updates: Partial<typeof webServerSettings.$inferInsert>,
) => {
	const current = await getWebServerSettings();
	if (!current) {
		throw new Error("Web server settings not found");
	}

	const [updated] = await db
		.update(webServerSettings)
		.set({
			...updates,
			updatedAt: new Date(),
		})
		.where(eq(webServerSettings.id, current.id))
		.returning();

	return updated;
};
