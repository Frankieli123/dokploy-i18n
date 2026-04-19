import { apiKeyClient } from "@better-auth/api-key/client";
import { ssoClient } from "@better-auth/sso/client";
import {
	adminClient,
	inferAdditionalFields,
	organizationClient,
	twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
	plugins: [
		organizationClient(),
		twoFactorClient(),
		apiKeyClient(),
		ssoClient(),
		adminClient(),
		inferAdditionalFields({
			user: {
				lastName: {
					type: "string",
				},
			},
		}),
	],
});
