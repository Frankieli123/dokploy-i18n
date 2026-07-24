import type { BetterAuthOptions } from "better-auth";

export const getAuthCookieOptions = (
	isCloud: boolean,
): Pick<BetterAuthOptions, "advanced"> =>
	isCloud
		? {}
		: {
				advanced: {
					useSecureCookies: false,
					defaultCookieAttributes: {
						sameSite: "lax",
						secure: false,
						httpOnly: true,
						path: "/",
					},
				},
			};

export const resolveSelfHostedServerIp = async (
	configuredServerIp: string | null | undefined,
	lookupPublicIp: () => Promise<string | null>,
) => configuredServerIp || (await lookupPublicIp());
