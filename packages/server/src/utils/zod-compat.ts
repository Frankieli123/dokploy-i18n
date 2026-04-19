import { z } from "zod";

const kindMap: Record<string, string> = {
	ZodArray: "array",
	ZodBoolean: "boolean",
	ZodBranded: "branded",
	ZodDate: "date",
	ZodDefault: "default",
	ZodEffects: "effects",
	ZodEnum: "enum",
	ZodIntersection: "intersection",
	ZodLazy: "lazy",
	ZodLiteral: "literal",
	ZodNativeEnum: "enum",
	ZodNullable: "nullable",
	ZodNumber: "number",
	ZodObject: "object",
	ZodOptional: "optional",
	ZodPipeline: "pipe",
	ZodReadonly: "readonly",
	ZodString: "string",
	ZodUnion: "union",
};

type CompatDef = {
	type?: string;
	typeName?: string;
	shape?: Record<string, z.ZodTypeAny> | (() => Record<string, z.ZodTypeAny>);
	values?: unknown[] | Record<string, unknown>;
	entries?: Record<string, unknown>;
	value?: unknown;
	options?: z.ZodTypeAny[];
	left?: z.ZodTypeAny;
	right?: z.ZodTypeAny;
	innerType?: z.ZodTypeAny;
	out?: z.ZodTypeAny;
	schema?: z.ZodTypeAny;
	getter?: () => z.ZodTypeAny;
};

function getCompatDef(schema: z.ZodTypeAny): CompatDef | undefined {
	return (
		(schema as unknown as { _zod?: { def?: CompatDef } })._zod?.def ??
		(schema as unknown as { _def?: CompatDef })._def
	);
}

export function getZodKind(schema: z.ZodTypeAny): string | undefined {
	const def = getCompatDef(schema);
	if (typeof def?.type === "string") return def.type;
	if (typeof def?.typeName === "string") {
		return kindMap[def.typeName] ?? def.typeName.replace(/^Zod/, "").toLowerCase();
	}
	return undefined;
}

export function isZodKind(
	schema: z.ZodTypeAny,
	kinds: string | readonly string[],
): boolean {
	const current = getZodKind(schema);
	if (!current) return false;
	return Array.isArray(kinds) ? kinds.includes(current) : current === kinds;
}

export function unwrapZodSchema(schema: z.ZodTypeAny): {
	schema: z.ZodTypeAny;
	flags: { optional: boolean; nullable: boolean; hasDefault: boolean };
} {
	let current = schema;
	const flags = { optional: false, nullable: false, hasDefault: false };

	while (true) {
		const kind = getZodKind(current);
		const def = getCompatDef(current);

		if (kind === "optional") {
			flags.optional = true;
			current =
				(current as z.ZodTypeAny & { unwrap?: () => z.ZodTypeAny }).unwrap?.() ??
				def?.innerType ??
				current;
			continue;
		}
		if (kind === "nullable") {
			flags.nullable = true;
			current =
				(current as z.ZodTypeAny & { unwrap?: () => z.ZodTypeAny }).unwrap?.() ??
				def?.innerType ??
				current;
			continue;
		}
		if (kind === "default") {
			flags.hasDefault = true;
			current =
				(current as z.ZodTypeAny & {
					removeDefault?: () => z.ZodTypeAny;
					unwrap?: () => z.ZodTypeAny;
				}).removeDefault?.() ??
				(current as z.ZodTypeAny & { unwrap?: () => z.ZodTypeAny }).unwrap?.() ??
				def?.innerType ??
				current;
			continue;
		}
		if (kind === "effects") {
			current = def?.schema ?? current;
			continue;
		}
		if (kind === "pipe") {
			current = def?.out ?? current;
			continue;
		}
		if (kind === "branded") {
			current = (def as { type?: z.ZodTypeAny } | undefined)?.type ?? current;
			continue;
		}
		if (kind === "readonly") {
			current = def?.innerType ?? current;
			continue;
		}
		if (kind === "lazy") {
			current = def?.getter?.() ?? current;
			continue;
		}
		break;
	}

	return { schema: current, flags };
}

export function isZodObject(schema: z.ZodTypeAny): schema is z.ZodObject<any> {
	return isZodKind(schema, "object");
}

export function getZodObjectShape(
	schema: z.ZodTypeAny,
): Record<string, z.ZodTypeAny> {
	if (!isZodObject(schema)) return {};
	const def = getCompatDef(schema);
	if (typeof def?.shape === "function") return def.shape();
	if (def?.shape) return def.shape;
	return (
		(schema as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape ?? {}
	);
}

export function getZodTypeLabel(schema: z.ZodTypeAny): string {
	const kind = getZodKind(schema);
	if (!kind) return "unknown";
	return kind.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

export function getZodLiteralValue(schema: z.ZodTypeAny): unknown {
	const def = getCompatDef(schema);
	if (Array.isArray(def?.values)) return def.values[0];
	return def?.value;
}

export function getZodEnumValues(schema: z.ZodTypeAny): string[] {
	const def = getCompatDef(schema);
	if (Array.isArray(def?.values)) {
		return def.values.filter((value): value is string => typeof value === "string");
	}
	if (def?.entries && typeof def.entries === "object") {
		return Object.values(def.entries).filter(
			(value): value is string => typeof value === "string",
		);
	}
	if (def?.values && typeof def.values === "object") {
		return Object.values(def.values).filter(
			(value): value is string => typeof value === "string",
		);
	}
	return [];
}

export function getZodUnionOptions(schema: z.ZodTypeAny): z.ZodTypeAny[] {
	const def = getCompatDef(schema);
	return Array.isArray(def?.options) ? def.options : [];
}

export function getZodIntersectionSides(schema: z.ZodTypeAny): {
	left?: z.ZodTypeAny;
	right?: z.ZodTypeAny;
} {
	const def = getCompatDef(schema);
	return {
		left: def?.left,
		right: def?.right,
	};
}
