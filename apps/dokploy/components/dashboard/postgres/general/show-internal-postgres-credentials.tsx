import { useTranslation } from "next-i18next";
import { ToggleVisibilityInput } from "@/components/shared/toggle-visibility-input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/utils/api";

interface Props {
	postgresId: string;
}
export const ShowInternalPostgresCredentials = ({ postgresId }: Props) => {
	const { t } = useTranslation("common");
	const { data } = api.postgres.one.useQuery({ postgresId });
	return (
		<>
			<div className="flex w-full flex-col gap-5 ">
				<Card className="bg-background">
					<CardHeader>
						<CardTitle className="text-xl">
							{t("database.postgres.internalCredentials.title")}
						</CardTitle>
					</CardHeader>
					<CardContent className="flex w-full flex-row gap-4">
						<div className="grid w-full md:grid-cols-2 gap-4 md:gap-8">
							<div className="flex flex-col gap-2">
								<Label>
									{t("database.postgres.internalCredentials.userLabel")}
								</Label>
								<Input disabled value={data?.databaseUser} />
							</div>
							<div className="flex flex-col gap-2">
								<Label>{t("database.form.databaseNameLabel")}</Label>
								<Input disabled value={data?.databaseName} />
							</div>
							<div className="flex flex-col gap-2">
								<Label>{t("database.form.databasePasswordLabel")}</Label>
								<div className="flex flex-row gap-4">
									<ToggleVisibilityInput
										value={data?.databasePassword}
										disabled
									/>
								</div>
							</div>
							<div className="flex flex-col gap-2">
								<Label>
									{t("database.postgres.internalCredentials.internalPortLabel")}
								</Label>
								<Input disabled value="5432" />
							</div>

							<div className="flex flex-col gap-2">
								<Label>
									{t("database.postgres.internalCredentials.internalHostLabel")}
								</Label>
								<Input disabled value={data?.appName} />
							</div>

							<div className="flex flex-col gap-2">
								<Label>
									{t(
										"database.postgres.internalCredentials.internalConnectionUrlLabel",
									)}
								</Label>
								<ToggleVisibilityInput
									disabled
									value={`postgresql://${data?.databaseUser}:${data?.databasePassword}@${data?.appName}:5432/${data?.databaseName}`}
								/>
							</div>
						</div>
					</CardContent>
				</Card>
			</div>
		</>
	);
};
// ReplyError: MISCONF Redis is configured to save RDB snapshots, but it's currently unable to persist to disk. Commands that may modify the data set are disabled, because this instance is configured to report errors during writes if RDB snapshotting fails (stop-w
