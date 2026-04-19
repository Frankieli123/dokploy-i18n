"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, LogIn } from "lucide-react";
import { useTranslation } from "next-i18next";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

const createSchema = (t: (key: string) => string) =>
	z.object({
		email: z
			.string()
			.min(1, {
				message: t("auth.validation.emailRequired"),
			})
			.email({
				message: t("auth.validation.emailInvalid"),
			})
			.transform((value) => value.trim()),
	});

type SSOEmailForm = {
	email: string;
};

interface Props {
	children: React.ReactNode;
}

export function SignInWithSSO({ children }: Props) {
	const { t } = useTranslation("common");
	const [expanded, setExpanded] = useState(false);
	const schema = createSchema(t);

	const form = useForm<SSOEmailForm>({
		resolver: zodResolver(schema as any) as any,
		defaultValues: {
			email: "",
		},
	});

	const onSubmit = async (values: SSOEmailForm) => {
		try {
			const { data, error } = await authClient.signIn.sso({
				email: values.email,
				callbackURL: "/dashboard/projects",
			});

			if (error) {
				toast.error(error.message ?? t("auth.sso.error"));
				return;
			}

			if (data?.url) {
				window.location.href = data.url;
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t("auth.sso.error"));
		}
	};

	if (!expanded) {
		return (
			<div className="mb-4 space-y-2">
				<Button
					type="button"
					variant="outline"
					className="w-full"
					onClick={() => setExpanded(true)}
				>
					<LogIn className="mr-2 size-4" />
					{t("auth.sso.signInButton")}
				</Button>
				{children}
			</div>
		);
	}

	return (
		<div className="mb-4 space-y-2">
			<Form {...form}>
				<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-2">
					<FormField
						control={form.control}
						name="email"
						render={({ field }) => (
							<FormItem>
								<FormControl>
									<div className="flex gap-2">
										<Input
											type="email"
											placeholder={t("auth.sso.emailPlaceholder")}
											autoComplete="email"
											disabled={form.formState.isSubmitting}
											className="flex-1"
											{...field}
										/>
										<Button
											type="submit"
											variant="outline"
											disabled={form.formState.isSubmitting}
										>
											{form.formState.isSubmitting ? (
												<Loader2 className="size-4 animate-spin" />
											) : (
												t("auth.sso.continueButton")
											)}
										</Button>
									</div>
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					<button
						type="button"
						onClick={() => setExpanded(false)}
						className="text-xs text-muted-foreground hover:underline"
					>
						{t("auth.sso.usePasswordInstead")}
					</button>
				</form>
			</Form>
		</div>
	);
}
