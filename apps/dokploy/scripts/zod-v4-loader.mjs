export async function resolve(specifier, context, nextResolve) {
	if (specifier === "zod") {
		return nextResolve("zod/v4", context);
	}

	return nextResolve(specifier, context);
}
