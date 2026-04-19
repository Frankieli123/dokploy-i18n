#!/usr/bin/env tsx

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateOpenApiDocument } from "@dokploy/trpc-openapi";
import { z } from "zod";
import { appRouter } from "../server/api/root";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type ZodLike = z.ZodTypeAny & {
	_def?: Record<string, unknown>;
	_zod?: { def?: Record<string, unknown> };
	meta?: (metadata?: Record<string, unknown>) => unknown;
};

const schemaCache = new WeakMap<object, z.ZodTypeAny>();
const openApiInputOverrides: Record<string, z.ZodTypeAny> = {
	"ai.mcpServers.create": z.object({
		transportType: z.enum(["http", "stdio"]).optional(),
		name: z.string().min(1),
		serverUrl: z.string().optional(),
		headers: z
			.array(
				z.object({
					key: z.string().min(1),
					value: z.string(),
				}),
			)
			.optional(),
		command: z.string().optional(),
		args: z.array(z.string()).optional(),
		env: z
			.array(
				z.object({
					key: z.string().min(1),
					value: z.string(),
				}),
			)
			.optional(),
		cwd: z.string().nullable().optional(),
		isEnabled: z.boolean().optional(),
	}).strict(),
	"ai.mcpServers.update": z.object({
		mcpServerId: z.string().min(1),
		name: z.string().min(1).optional(),
		serverUrl: z.string().optional(),
		headers: z
			.array(
				z.object({
					key: z.string().min(1),
					value: z.string(),
				}),
			)
			.optional(),
		command: z.string().optional(),
		args: z.array(z.string()).optional(),
		env: z
			.array(
				z.object({
					key: z.string().min(1),
					value: z.string(),
				}),
			)
			.optional(),
		cwd: z.string().nullable().optional(),
		isEnabled: z.boolean().optional(),
	}).strict(),
	"sso.register": z.object({
		providerId: z.string().min(1),
		issuer: z.string().min(1),
		domains: z.array(z.string().min(1)),
		oidcConfig: z
			.object({
				clientId: z.string().optional(),
				clientSecret: z.string().optional(),
				authorizationEndpoint: z.string().optional(),
				tokenEndpoint: z.string().optional(),
				userInfoEndpoint: z.string().optional(),
				tokenEndpointAuthentication: z
					.enum(["client_secret_post", "client_secret_basic"])
					.optional(),
				jwksEndpoint: z.string().optional(),
				discoveryEndpoint: z.string().optional(),
				skipDiscovery: z.boolean().optional(),
				scopes: z.array(z.string()).optional(),
				pkce: z.boolean().optional(),
			})
			.optional(),
		samlConfig: z
			.object({
				entryPoint: z.string().optional(),
				cert: z.string().optional(),
				callbackUrl: z.string().optional(),
				audience: z.string().optional(),
				privateKey: z.string().optional(),
				decryptionPvk: z.string().optional(),
			})
			.optional(),
		overrideUserInfo: z.boolean().optional(),
	}).strict(),
	"sso.update": z.object({
		providerId: z.string().min(1),
		issuer: z.string().min(1),
		domains: z.array(z.string().min(1)),
		oidcConfig: z
			.object({
				clientId: z.string().optional(),
				clientSecret: z.string().optional(),
				authorizationEndpoint: z.string().optional(),
				tokenEndpoint: z.string().optional(),
				userInfoEndpoint: z.string().optional(),
				tokenEndpointAuthentication: z
					.enum(["client_secret_post", "client_secret_basic"])
					.optional(),
				jwksEndpoint: z.string().optional(),
				discoveryEndpoint: z.string().optional(),
				skipDiscovery: z.boolean().optional(),
				scopes: z.array(z.string()).optional(),
				pkce: z.boolean().optional(),
			})
			.optional(),
		samlConfig: z
			.object({
				entryPoint: z.string().optional(),
				cert: z.string().optional(),
				callbackUrl: z.string().optional(),
				audience: z.string().optional(),
				privateKey: z.string().optional(),
				decryptionPvk: z.string().optional(),
			})
			.optional(),
		overrideUserInfo: z.boolean().optional(),
	}).strict(),
	"user.upsertCustomRole": z.object({
		role: z.string().min(1),
		permissions: z.array(
			z.object({
				resource: z.string().min(1),
				actions: z.array(z.string().min(1)),
			}),
		),
	}).strict(),
	"application.update": z.object({
		applicationId: z.string().min(1),
		name: z.string().optional(),
		description: z.string().optional(),
		env: z.string().optional(),
		buildArgs: z.string().optional(),
		buildSecrets: z.string().optional(),
		dockerImage: z.string().optional(),
		dockerfile: z.string().optional(),
		buildPath: z.string().optional(),
		customGitUrl: z.string().optional(),
		customGitBranch: z.string().optional(),
		customGitBuildPath: z.string().optional(),
		username: z.string().optional(),
		password: z.string().optional(),
		registryUrl: z.string().optional(),
		buildType: z
			.enum([
				"dockerfile",
				"heroku_buildpacks",
				"paketo_buildpacks",
				"nixpacks",
				"static",
				"railpack",
			])
			.optional(),
		sourceType: z
			.enum(["github", "docker", "git", "gitlab", "bitbucket", "gitea", "drop"])
			.optional(),
		enabled: z.boolean().optional(),
		cleanCache: z.boolean().optional(),
		replicas: z.number().optional(),
	}).strict(),
	"mysql.update": z.object({
		mysqlId: z.string().min(1),
		name: z.string().optional(),
		description: z.string().optional(),
		env: z.string().optional(),
		dockerImage: z.string().optional(),
		externalPort: z.number().optional(),
		databaseName: z.string().optional(),
		databaseUser: z.string().optional(),
		databasePassword: z.string().optional(),
		databaseRootPassword: z.string().optional(),
	}).strict(),
	"postgres.update": z.object({
		postgresId: z.string().min(1),
		name: z.string().optional(),
		description: z.string().optional(),
		env: z.string().optional(),
		dockerImage: z.string().optional(),
		externalPort: z.number().optional(),
		databaseName: z.string().optional(),
		databaseUser: z.string().optional(),
		databasePassword: z.string().optional(),
	}).strict(),
	"redis.update": z.object({
		redisId: z.string().min(1),
		name: z.string().optional(),
		description: z.string().optional(),
		env: z.string().optional(),
		dockerImage: z.string().optional(),
		externalPort: z.number().optional(),
		databasePassword: z.string().optional(),
	}).strict(),
	"mongo.update": z.object({
		mongoId: z.string().min(1),
		name: z.string().optional(),
		description: z.string().optional(),
		env: z.string().optional(),
		dockerImage: z.string().optional(),
		externalPort: z.number().optional(),
		databaseUser: z.string().optional(),
		databasePassword: z.string().optional(),
		replicaSets: z.boolean().optional(),
	}).strict(),
	"mariadb.update": z.object({
		mariadbId: z.string().min(1),
		name: z.string().optional(),
		description: z.string().optional(),
		env: z.string().optional(),
		dockerImage: z.string().optional(),
		externalPort: z.number().optional(),
		databaseName: z.string().optional(),
		databaseUser: z.string().optional(),
		databasePassword: z.string().optional(),
		databaseRootPassword: z.string().optional(),
	}).strict(),
	"domain.create": z.object({
		host: z.string().min(1),
		path: z.string().optional(),
		internalPath: z.string().optional(),
		stripPath: z.boolean().optional(),
		port: z.number().optional(),
		https: z.boolean().optional(),
		certificateType: z.enum(["letsencrypt", "none", "custom"]).optional(),
		customCertResolver: z.string().optional(),
		applicationId: z.string().optional(),
		composeId: z.string().optional(),
		serviceName: z.string().optional(),
		domainType: z.enum(["compose", "application", "preview"]).optional(),
		previewDeploymentId: z.string().optional(),
	}).strict(),
	"domain.update": z.object({
		domainId: z.string().min(1),
		host: z.string().min(1),
		path: z.string().optional(),
		internalPath: z.string().optional(),
		stripPath: z.boolean().optional(),
		port: z.number().optional(),
		https: z.boolean().optional(),
		certificateType: z.enum(["letsencrypt", "none", "custom"]).optional(),
		customCertResolver: z.string().optional(),
		serviceName: z.string().optional(),
		domainType: z.enum(["compose", "application", "preview"]).optional(),
	}).strict(),
};

function getSchemaDef(schema: ZodLike): Record<string, unknown> | undefined {
	return schema._zod?.def ?? schema._def;
}

function getSchemaKind(schema: z.ZodTypeAny): string | undefined {
	const def = getSchemaDef(schema as ZodLike);
	const type = def?.type;
	if (typeof type === "string") return type;

	const typeName = def?.typeName;
	if (typeof typeName !== "string") return undefined;
	if (typeName === "ZodPipeline") return "pipe";
	if (typeName === "ZodNativeEnum") return "enum";
	return typeName.replace(/^Zod/, "").toLowerCase();
}

function getSchemaMeta(schema: z.ZodTypeAny): Record<string, unknown> | undefined {
	try {
		return (schema as ZodLike).meta?.() as Record<string, unknown> | undefined;
	} catch {
		return undefined;
	}
}

function applySchemaMeta(
	schema: z.ZodTypeAny,
	meta?: Record<string, unknown>,
): z.ZodTypeAny {
	if (!meta || typeof (schema as ZodLike).meta !== "function") return schema;
	return (schema as ZodLike).meta!(meta) as z.ZodTypeAny;
}

function sanitizeSchema(schema: z.ZodTypeAny | undefined): z.ZodTypeAny | undefined {
	if (!schema || typeof schema !== "object") return schema;

	const cached = schemaCache.get(schema as object);
	if (cached) return cached;

	const def = getSchemaDef(schema as ZodLike);
	const kind = getSchemaKind(schema);
	const meta = getSchemaMeta(schema);
	let next: z.ZodTypeAny = schema;

	switch (kind) {
		case "nonoptional": {
			const inner = (def?.innerType as z.ZodTypeAny | undefined) ?? schema;
			const sanitizedInner = sanitizeSchema(inner) ?? inner;
			const innerDef = getSchemaDef(sanitizedInner as ZodLike);
			next =
				getSchemaKind(sanitizedInner) === "optional"
					? (sanitizeSchema(innerDef?.innerType as z.ZodTypeAny | undefined) ??
						sanitizedInner)
					: sanitizedInner;
			break;
		}
		case "optional": {
			const inner =
				schema.unwrap?.() ??
				((def?.innerType as z.ZodTypeAny | undefined) ?? schema);
			next = (sanitizeSchema(inner) ?? inner).optional();
			break;
		}
		case "nullable": {
			const inner =
				schema.unwrap?.() ??
				((def?.innerType as z.ZodTypeAny | undefined) ?? schema);
			next = (sanitizeSchema(inner) ?? inner).nullable();
			break;
		}
		case "default": {
			const inner = (def?.innerType as z.ZodTypeAny | undefined) ?? schema;
			const defaultValue =
				typeof (schema as any)._def?.defaultValue === "function"
					? (schema as any)._def.defaultValue()
					: undefined;
			next =
				defaultValue !== undefined
					? (sanitizeSchema(inner) ?? inner).default(defaultValue)
					: sanitizeSchema(inner) ?? inner;
			break;
		}
		case "effects": {
			const inner = (def?.schema as z.ZodTypeAny | undefined) ?? schema;
			next = sanitizeSchema(inner) ?? inner;
			break;
		}
		case "pipe": {
			const inner =
				(def?.out as z.ZodTypeAny | undefined) ??
				(def?.schema as z.ZodTypeAny | undefined) ??
				schema;
			next = sanitizeSchema(inner) ?? inner;
			break;
		}
		case "readonly":
		case "branded": {
			const inner =
				(def?.innerType as z.ZodTypeAny | undefined) ??
				(def?.type as z.ZodTypeAny | undefined) ??
				schema;
			next = sanitizeSchema(inner) ?? inner;
			break;
		}
		case "lazy": {
			const inner = (def?.getter as (() => z.ZodTypeAny) | undefined)?.() ?? schema;
			next = sanitizeSchema(inner) ?? inner;
			break;
		}
		case "object": {
			const rawShape =
				typeof def?.shape === "function"
					? (def.shape as () => Record<string, z.ZodTypeAny>)()
					: ((def?.shape as Record<string, z.ZodTypeAny> | undefined) ??
						(schema as any).shape ??
						{});
			next = z.object(
				Object.fromEntries(
					Object.entries(rawShape)
						.filter(([, value]) => Boolean(value))
						.map(([key, value]) => [
							key,
							sanitizeSchema(value as z.ZodTypeAny) ?? (value as z.ZodTypeAny),
						]),
				),
			);
			break;
		}
		case "array": {
			const inner =
				((schema as any).element as z.ZodTypeAny | undefined) ??
				(def?.element as z.ZodTypeAny | undefined) ??
				schema;
			next = z.array(sanitizeSchema(inner) ?? inner);
			break;
		}
		case "union": {
			const options = ((def?.options as z.ZodTypeAny[] | undefined) ?? [])
				.filter(Boolean)
				.map((option) => sanitizeSchema(option) ?? option);
			if (options.length >= 2) {
				next = z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
			}
			break;
		}
		case "intersection": {
			const left = sanitizeSchema(def?.left as z.ZodTypeAny | undefined);
			const right = sanitizeSchema(def?.right as z.ZodTypeAny | undefined);
			if (left && right) {
				next = z.intersection(left, right);
			}
			break;
		}
	}

	next = applySchemaMeta(next, meta);
	schemaCache.set(schema as object, next);
	return next;
}

function sanitizeRouterForOpenApi(router: typeof appRouter) {
	for (const [key, procedure] of Object.entries(
		(router as any)._def.procedures,
	) as Array<[string, any]>) {
		const inputOverride = openApiInputOverrides[key];
		if (inputOverride) {
			procedure._def.inputs = [inputOverride];
		}

		procedure._def.inputs = (procedure._def.inputs as z.ZodTypeAny[]).map(
			(schema) => sanitizeSchema(schema) ?? schema,
		);
		if (procedure._def.output) {
			procedure._def.output =
				sanitizeSchema(procedure._def.output as z.ZodTypeAny) ??
				procedure._def.output;
		}
	}

	return router;
}

function createRouterWithSingleProcedure(
	router: typeof appRouter,
	key: string,
	procedure: unknown,
) {
	return {
		...(router as any),
		_def: {
			...(router as any)._def,
			procedures: { [key]: procedure },
		},
	};
}

function filterSupportedProcedures(
	router: typeof appRouter,
	opts: Parameters<typeof generateOpenApiDocument>[1],
) {
	const supported: Record<string, unknown> = {};
	const skipped: string[] = [];

	for (const [key, procedure] of Object.entries((router as any)._def.procedures)) {
		try {
			generateOpenApiDocument(
				createRouterWithSingleProcedure(router, key, procedure) as typeof appRouter,
				opts,
			);
			supported[key] = procedure;
		} catch {
			skipped.push(key);
		}
	}

	return {
		router: {
			...(router as any),
			_def: {
				...(router as any)._def,
				procedures: supported,
			},
		} as typeof appRouter,
		skipped,
	};
}

async function generateOpenAPI() {
	try {
		console.log("Generating OpenAPI specification...");

		const sanitizedRouter = sanitizeRouterForOpenApi(appRouter);
		const openApiOpts = {
			title: "Dokploy API",
			version: "1.0.0",
			baseUrl: "https://your-dokploy-instance.com/api",
			docsUrl: "https://docs.dokploy.com/api",
			tags: [
				"admin",
				"docker",
				"compose",
				"registry",
				"cluster",
				"user",
				"domain",
				"destination",
				"backup",
				"deployment",
				"mounts",
				"certificates",
				"settings",
				"security",
				"redirects",
				"port",
				"project",
				"application",
				"mysql",
				"postgres",
				"redis",
				"mongo",
				"mariadb",
				"sshRouter",
				"gitProvider",
				"bitbucket",
				"github",
				"gitlab",
				"gitea",
				"server",
				"swarm",
				"ai",
				"organization",
				"schedule",
				"rollback",
				"volumeBackups",
				"environment",
			],
		} as const;

		const { router: supportedRouter, skipped } = filterSupportedProcedures(
			sanitizedRouter,
			openApiOpts,
		);

		if (process.env.OPENAPI_DEBUG === "1" && skipped.length > 0) {
			console.error("OpenAPI debug skipped procedures:", skipped);
		}

		const openApiDocument = generateOpenApiDocument(
			supportedRouter,
			{
				...openApiOpts,
			},
		);

		openApiDocument.info = {
			title: "Dokploy API",
			description:
				"Complete API documentation for Dokploy - Deploy applications, manage databases, and orchestrate your infrastructure. This API allows you to programmatically manage all aspects of your Dokploy instance.",
			version: "1.0.0",
			contact: {
				name: "Dokploy Team",
				url: "https://dokploy.com",
			},
			license: {
				name: "Apache 2.0",
				url: "https://github.com/Frankieli123/dokploy-i18n/blob/main/LICENSE",
			},
		};

		openApiDocument.components = {
			...openApiDocument.components,
			securitySchemes: {
				apiKey: {
					type: "apiKey",
					in: "header",
					name: "x-api-key",
					description:
						"API key authentication. Generate an API key from your Dokploy dashboard under Settings > API Keys.",
				},
			},
		};

		openApiDocument.security = [{ apiKey: [] }];
		openApiDocument.externalDocs = {
			description: "Full documentation",
			url: "https://docs.dokploy.com",
		};

		const outputPath = resolve(__dirname, "../../../openapi.json");
		writeFileSync(outputPath, JSON.stringify(openApiDocument, null, 2), "utf-8");

		console.log("OpenAPI specification generated successfully!");
		console.log(`Output: ${outputPath}`);
		console.log(`Endpoints: ${Object.keys(openApiDocument.paths || {}).length}`);
		if (skipped.length > 0) {
			console.warn(`Skipped procedures: ${skipped.join(", ")}`);
		}
		process.exit(0);
	} catch (error) {
		console.error("Error generating OpenAPI specification:", error);
		process.exit(1);
	}
}

generateOpenAPI();
