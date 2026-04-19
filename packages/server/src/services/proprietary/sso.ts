import { db } from "@dokploy/server/db";
import { organization, ssoProvider } from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";

export const requestToHeaders = (req: {
	headers?: Record<string, string | string[] | undefined>;
}): Headers => {
	const headers = new Headers();
	if (!req.headers) return headers;

	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined || key.toLowerCase() === "host") continue;
		headers.set(key, Array.isArray(value) ? value.join(", ") : value);
	}

	return headers;
};

export const normalizeTrustedOrigin = (value: string): string =>
	value.trim().replace(/\/+$/, "");

export const getOrganizationOwnerId = async (organizationId: string) => {
	const org = await db.query.organization.findFirst({
		where: eq(organization.id, organizationId),
		columns: {
			ownerId: true,
		},
	});

	return org?.ownerId ?? null;
};

export const getSSOProviders = async () => {
	return db.query.ssoProvider.findMany({
		columns: {
			id: true,
			providerId: true,
			issuer: true,
			domain: true,
			oidcConfig: true,
			samlConfig: true,
		},
	});
};
