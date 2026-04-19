export {};

declare global {
	interface Window {
		chatwootSettings?: {
			position?: "left" | "right";
		};
		chatwootSDKReady?: () => void;
		chatwootSDK?: {
			run: (options: { websiteToken: string; baseUrl: string }) => void;
		};
		$chatwoot?: {
			setUser: (
				identifier: string,
				payload: {
					email?: string;
					name?: string;
					avatar_url?: string;
					phone_number?: string;
				},
			) => void;
		};
	}
}
