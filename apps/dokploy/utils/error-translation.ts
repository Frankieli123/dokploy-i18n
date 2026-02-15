import type { TFunction } from "next-i18next";

const TRANSLATABLE_PREFIXES = ["settings.", "common.", "auth."] as const;

export function translateErrorMessage(
	errorMessage: string,
	t: TFunction,
): string {
	const key = typeof errorMessage === "string" ? errorMessage.trim() : "";
	if (!key) return "";
	if (!TRANSLATABLE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
		return errorMessage;
	}

	const namespace = key.split(".", 1)[0];
	const translatedWithNamespace = t(key, {
		ns: namespace,
		defaultValue: key,
	});
	if (translatedWithNamespace !== key) {
		return translatedWithNamespace;
	}

	const translated = t(key, { defaultValue: key });
	return translated === key ? errorMessage : translated;
}
