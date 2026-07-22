import { exec } from "node:child_process";
import { exit } from "node:process";
import { promisify } from "node:util";
import { setupDirectories } from "@dokploy/server/setup/config-paths";
import { initializePostgres } from "@dokploy/server/setup/postgres-setup";
import { initializeRedis } from "@dokploy/server/setup/redis-setup";
import {
	initializeNetwork,
	initializeSwarm,
} from "@dokploy/server/setup/setup";
import {
	createDefaultMiddlewares,
	createDefaultServerTraefikConfig,
	createDefaultTraefikConfig,
	initializeStandaloneTraefik,
	migrateCertificateTraefikConfigs,
} from "@dokploy/server/setup/traefik-setup";

const execAsync = promisify(exec);

(async () => {
	try {
		setupDirectories();
		createDefaultMiddlewares();
		await initializeSwarm();
		await initializeNetwork();
		createDefaultTraefikConfig();
		migrateCertificateTraefikConfigs();
		createDefaultServerTraefikConfig();
		await execAsync("docker pull traefik:v3.6.1");
		await initializeStandaloneTraefik();
		await initializeRedis();
		await initializePostgres();
		console.log("Dokploy setup completed");
		exit(0);
	} catch (e) {
		console.error("Error in dokploy setup", e);
	}
})();
