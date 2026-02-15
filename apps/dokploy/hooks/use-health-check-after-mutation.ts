import { useCallback, useState } from "react";
import { toast } from "sonner";

const HEALTH_CHECK_URL = "/api/health";

export interface UseHealthCheckAfterMutationOptions {
	initialDelay?: number;
	pollInterval?: number;
	successMessage: string;
	onSuccess?: () => void | Promise<void>;
	reloadOnSuccess?: boolean;
}

export const useHealthCheckAfterMutation = ({
	initialDelay = 5000,
	pollInterval = 2000,
	successMessage,
	onSuccess,
	reloadOnSuccess = false,
}: UseHealthCheckAfterMutationOptions) => {
	const [isExecuting, setIsExecuting] = useState(false);

	const checkHealth = useCallback(async (): Promise<boolean> => {
		try {
			const response = await fetch(HEALTH_CHECK_URL);
			return response.ok;
		} catch {
			return false;
		}
	}, []);

	const pollUntilHealthy = useCallback(async (): Promise<void> => {
		const isHealthy = await checkHealth();
		if (isHealthy) {
			toast.success(successMessage);

			if (reloadOnSuccess) {
				setTimeout(() => {
					window.location.reload();
				}, 2000);
			} else {
				await onSuccess?.();
			}
			return;
		}

		await new Promise((resolve) => setTimeout(resolve, pollInterval));
		await pollUntilHealthy();
	}, [checkHealth, successMessage, reloadOnSuccess, onSuccess, pollInterval]);

	const execute = useCallback(
		async <T>(mutationFn: () => Promise<T>): Promise<T> => {
			setIsExecuting(true);
			try {
				const result = await mutationFn();
				await new Promise((resolve) => setTimeout(resolve, initialDelay));
				await pollUntilHealthy();
				return result;
			} finally {
				setIsExecuting(false);
			}
		},
		[initialDelay, pollUntilHealthy],
	);

	return { execute, isExecuting };
};
