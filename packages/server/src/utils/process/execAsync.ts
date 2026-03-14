import { exec, execFile } from "node:child_process";
import util from "node:util";
import { findServerById } from "@dokploy/server/services/server";
import { Client } from "ssh2";
import { ExecError } from "./ExecError";

// Re-export ExecError for easier imports
export { ExecError } from "./ExecError";

const execAsyncBase = util.promisify(exec);

interface ExecAsyncOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	shell?: string;
	timeoutMs?: number;
	maxBufferBytes?: number;
}

function toNodeExecOptions(options: ExecAsyncOptions | undefined) {
	if (!options) return undefined;
	const { timeoutMs, maxBufferBytes, ...rest } = options;
	const out = { ...rest } as Record<string, unknown>;
	if (
		typeof timeoutMs === "number" &&
		Number.isFinite(timeoutMs) &&
		timeoutMs > 0
	) {
		out.timeout = Math.floor(timeoutMs);
	}
	if (
		typeof maxBufferBytes === "number" &&
		Number.isFinite(maxBufferBytes) &&
		maxBufferBytes > 0
	) {
		out.maxBuffer = Math.floor(maxBufferBytes);
	}
	return out as Parameters<typeof exec>[1];
}

export const execAsync = async (
	command: string,
	options?: ExecAsyncOptions,
): Promise<{ stdout: string; stderr: string }> => {
	try {
		const result = await execAsyncBase(
			command,
			toNodeExecOptions(options) as any,
		);
		return {
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	} catch (error) {
		if (error instanceof Error) {
			// @ts-ignore - exec error has these properties
			const exitCode = error.code;
			// @ts-ignore
			const stdout = error.stdout?.toString() || "";
			// @ts-ignore
			const stderr = error.stderr?.toString() || "";

			throw new ExecError(`Command execution failed: ${error.message}`, {
				command,
				stdout,
				stderr,
				exitCode,
				originalError: error,
			});
		}
		throw error;
	}
};

export const execAsyncStream = (
	command: string,
	onData?: (data: string) => void,
	options: Omit<ExecAsyncOptions, "shell"> = {},
): Promise<{ stdout: string; stderr: string }> => {
	return new Promise((resolve, reject) => {
		let stdoutComplete = "";
		let stderrComplete = "";

		const childProcess = exec(
			command,
			toNodeExecOptions(options as ExecAsyncOptions) as any,
			(error) => {
				if (error) {
					reject(
						new ExecError(`Command execution failed: ${error.message}`, {
							command,
							stdout: stdoutComplete,
							stderr: stderrComplete,
							// @ts-ignore
							exitCode: error.code,
							originalError: error,
						}),
					);
					return;
				}
				resolve({ stdout: stdoutComplete, stderr: stderrComplete });
			},
		);

		childProcess.stdout?.on("data", (data: Buffer | string) => {
			const stringData = data.toString();
			stdoutComplete += stringData;
			if (onData) {
				onData(stringData);
			}
		});

		childProcess.stderr?.on("data", (data: Buffer | string) => {
			const stringData = data.toString();
			stderrComplete += stringData;
			if (onData) {
				onData(stringData);
			}
		});

		childProcess.on("error", (error) => {
			console.log(error);
			reject(
				new ExecError(`Command execution error: ${error.message}`, {
					command,
					stdout: stdoutComplete,
					stderr: stderrComplete,
					originalError: error,
				}),
			);
		});
	});
};

export const execFileAsync = async (
	command: string,
	args: string[],
	options: { input?: string } = {},
): Promise<{ stdout: string; stderr: string }> => {
	const child = execFile(command, args);

	if (options.input && child.stdin) {
		child.stdin.write(options.input);
		child.stdin.end();
	}

	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";

		child.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("close", (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				reject(
					new Error(`Command failed with code ${code}. Stderr: ${stderr}`),
				);
			}
		});

		child.on("error", reject);
	});
};

export const execAsyncRemote = async (
	serverId: string | null,
	command: string,
	onData?: (data: string) => void,
	options?: { timeoutMs?: number; maxBufferBytes?: number },
): Promise<{ stdout: string; stderr: string }> => {
	if (!serverId) return { stdout: "", stderr: "" };
	const server = await findServerById(serverId);
	if (!server.sshKeyId) throw new Error("No SSH key available for this server");

	let stdout = "";
	let stderr = "";
	return new Promise((resolve, reject) => {
		const conn = new Client();
		let settled = false;
		let streamRef: { close: () => void; end: () => void } | null = null;
		const timeoutMs =
			typeof options?.timeoutMs === "number" &&
			Number.isFinite(options.timeoutMs)
				? Math.max(1, Math.floor(options.timeoutMs))
				: 0;
		const maxBufferBytes =
			typeof options?.maxBufferBytes === "number" &&
			Number.isFinite(options.maxBufferBytes)
				? Math.max(1, Math.floor(options.maxBufferBytes))
				: 0;
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let timer: NodeJS.Timeout | null = null;

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			fn();
		};

		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				settle(() => {
					try {
						streamRef?.close();
					} catch {}
					try {
						streamRef?.end();
					} catch {}
					conn.end();
					reject(
						new ExecError(`Remote command timed out after ${timeoutMs}ms`, {
							command,
							stdout,
							stderr,
							exitCode: 124,
							serverId,
						}),
					);
				});
			}, timeoutMs);
		}

		sleep(1000);
		conn
			.once("ready", () => {
				conn.exec(command, (err, stream) => {
					if (err) {
						onData?.(err.message);
						settle(() => {
							conn.end();
							reject(
								new ExecError(
									`Remote command execution failed: ${err.message}`,
									{
										command,
										serverId,
										originalError: err,
									},
								),
							);
						});
						return;
					}

					streamRef = stream as unknown as {
						close: () => void;
						end: () => void;
					};
					stream
						.on("close", (code: number, _signal: string) => {
							settle(() => {
								conn.end();
								if (code === 0) {
									resolve({ stdout, stderr });
									return;
								}
								reject(
									new ExecError(
										`Remote command failed with exit code ${code}`,
										{
											command,
											stdout,
											stderr,
											exitCode: code,
											serverId,
										},
									),
								);
							});
						})
						.on("data", (data: Buffer | string) => {
							const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
							if (onData) onData(buf.toString());

							if (maxBufferBytes > 0) {
								if (stdoutBytes < maxBufferBytes) {
									const remaining = maxBufferBytes - stdoutBytes;
									stdout += (
										buf.length <= remaining ? buf : buf.subarray(0, remaining)
									).toString();
								}
								stdoutBytes += buf.length;
								return;
							}

							stdout += buf.toString();
						})
						.stderr.on("data", (data: Buffer | string) => {
							const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
							if (onData) onData(buf.toString());

							if (maxBufferBytes > 0) {
								if (stderrBytes < maxBufferBytes) {
									const remaining = maxBufferBytes - stderrBytes;
									stderr += (
										buf.length <= remaining ? buf : buf.subarray(0, remaining)
									).toString();
								}
								stderrBytes += buf.length;
								return;
							}

							stderr += buf.toString();
						});
				});
			})
			.on("error", (err) => {
				settle(() => {
					conn.end();
					if (err.level === "client-authentication") {
						const errorMsg = `Authentication failed: Invalid SSH private key. Error: ${err.message} ${err.level}`;
						onData?.(errorMsg);
						reject(
							new ExecError(errorMsg, {
								command,
								serverId,
								originalError: err,
							}),
						);
						return;
					}
					const errorMsg = `SSH connection error: ${err.message}`;
					onData?.(errorMsg);
					reject(
						new ExecError(errorMsg, {
							command,
							serverId,
							originalError: err,
						}),
					);
				});
			})
			.connect({
				host: server.ipAddress,
				port: server.port,
				username: server.username,
				privateKey: server.sshKey?.privateKey,
				timeout: 99999,
			});
	});
};

export const sleep = (ms: number) => {
	return new Promise((resolve) => setTimeout(resolve, ms));
};
