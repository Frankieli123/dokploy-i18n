import { db } from "@dokploy/server/db";
import { twoFactor } from "@dokploy/server/db/schema";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { eq } from "drizzle-orm";

const oldSecret = process.env.OLD_SECRET;
const newSecret = process.env.NEW_SECRET;

if (!oldSecret || !newSecret) {
	console.error("OLD_SECRET and NEW_SECRET are required.");
	process.exit(1);
}

if (oldSecret === newSecret) {
	console.error("OLD_SECRET and NEW_SECRET must be different.");
	process.exit(1);
}

const reEncrypt = async (value: string) => {
	const plaintext = await symmetricDecrypt({ key: oldSecret, data: value });
	return symmetricEncrypt({ key: newSecret, data: plaintext });
};

const main = async () => {
	const records = await db.select().from(twoFactor);
	if (records.length === 0) {
		console.log("No 2FA records found, nothing to migrate.");
		process.exit(0);
	}

	await db.transaction(async (tx) => {
		for (const record of records) {
			const [secret, backupCodes] = await Promise.all([
				reEncrypt(record.secret),
				reEncrypt(record.backupCodes),
			]);
			await tx
				.update(twoFactor)
				.set({ secret, backupCodes })
				.where(eq(twoFactor.id, record.id));
		}
	});

	console.log(`Migrated ${records.length} 2FA record(s).`);
	process.exit(0);
};

main().catch((error) => {
	console.error("Auth secret migration failed:", error);
	process.exit(1);
});
