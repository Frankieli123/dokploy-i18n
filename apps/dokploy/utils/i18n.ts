import type { NextApiRequestCookies } from "next/dist/server/api-utils";
import { Languages } from "@/lib/languages";

export function getLocale(cookies: NextApiRequestCookies) {
	const locale = cookies.DOKPLOY_LOCALE ?? "en";
	return locale;
}

const DEFAULT_NAMESPACES = ["common"] as const;

export const serverSideTranslations = (
	locale: string,
	namespaces: string[] = [...DEFAULT_NAMESPACES],
) =>
	import(
		/* webpackIgnore: true */ "next-i18next/serverSideTranslations.js"
	).then((mod) => {
		const originalServerSideTranslations =
			(mod as any).serverSideTranslations ??
			(mod as any).default?.serverSideTranslations ??
			(mod as any).default;

		if (typeof originalServerSideTranslations !== "function") {
			throw new Error("Failed to load next-i18next serverSideTranslations");
		}

		return originalServerSideTranslations(
			locale,
			Array.from(new Set([...DEFAULT_NAMESPACES, ...namespaces])),
			{
				fallbackLng: "en",
				keySeparator: false,
				i18n: {
					defaultLocale: "en",
					locales: Object.values(Languages).map((language) => language.code),
					localeDetection: false,
				},
			},
		);
	});
