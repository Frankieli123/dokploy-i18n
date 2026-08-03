import { readSecret } from "../db/constants";

export const LEGACY_BETTER_AUTH_SECRET = "better-auth-secret-123456789";

type AuthSecretEnvironment = {
	BETTER_AUTH_SECRET?: string;
	BETTER_AUTH_SECRET_FILE?: string;
	NODE_ENV?: string;
};

export const resolveBetterAuthSecret = (
	env: AuthSecretEnvironment = process.env,
	readSecretFile: (path: string) => string = readSecret,
) => {
	if (env.BETTER_AUTH_SECRET) return env.BETTER_AUTH_SECRET;
	if (env.BETTER_AUTH_SECRET_FILE) {
		const secret = readSecretFile(env.BETTER_AUTH_SECRET_FILE);
		if (!secret) throw new Error("Better Auth secret file is empty");
		return secret;
	}
	if (env.NODE_ENV !== "test") {
		console.warn(`
⚠️  [DEPRECATED AUTH CONFIG]
BETTER_AUTH_SECRET is not configured. Falling back to the legacy shared secret.
Use BETTER_AUTH_SECRET or BETTER_AUTH_SECRET_FILE and migrate existing 2FA records before rotating it.
`);
	}
	return LEGACY_BETTER_AUTH_SECRET;
};

export const betterAuthSecret = resolveBetterAuthSecret();
