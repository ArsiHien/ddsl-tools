import * as vscode from 'vscode';
import * as path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import {
	CloseAction,
	ErrorAction,
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	State,
	TransportKind,
} from 'vscode-languageclient/node';
import { toErrorMessage } from './shared/errors';

let languageClient: LanguageClient | undefined;
let lastLanguageClientError: string | undefined;
let clientOutputChannel: vscode.OutputChannel | undefined;

type ServerLaunchConfig = {
	command: string;
	args?: string[];
	label: string;
};

export async function startLanguageClient(
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel
): Promise<string | undefined> {
	clientOutputChannel = outputChannel;
	lastLanguageClientError = undefined;

	const launch = await resolveServerLaunch(context);
	if (!launch) {
		return undefined;
	}

	const serverOptions: ServerOptions = {
		run: {
			command: launch.command,
			args: launch.args,
			transport: TransportKind.stdio,
		},
		debug: {
			command: launch.command,
			args: launch.args,
			transport: TransportKind.stdio,
		},
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'ddsl' }],
		outputChannel,
		errorHandler: {
			error: (error) => {
				const message = toErrorMessage(error, 'Unknown language client error.');
				lastLanguageClientError = message;
				outputChannel.appendLine(`Language client error: ${message}`);
				return { action: ErrorAction.Continue, handled: true };
			},
			closed: () => {
				const message = 'Language client connection closed.';
				lastLanguageClientError = message;
				outputChannel.appendLine(message);
				return { action: CloseAction.DoNotRestart, handled: true };
			},
		},
		synchronize: {
			fileEvents: vscode.workspace.createFileSystemWatcher('**/*.ddsl'),
		},
	};

	languageClient = new LanguageClient(
		'ddslLanguageServer',
		'DDSL Language Server',
		serverOptions,
		clientOptions
	);

	languageClient.onDidChangeState((event) => {
		outputChannel.appendLine(
			`Language client state: ${stateToString(event.oldState)} -> ${stateToString(event.newState)}`
		);
	});

	try {
		await languageClient.start();
		lastLanguageClientError = undefined;
		return launch.label;
	} catch (error) {
		const message = toErrorMessage(error, 'Failed to start the DDSL Language Server.');
		lastLanguageClientError = message;
		outputChannel.appendLine(`Language client start failed: ${message}`);
		languageClient = undefined;
		return undefined;
	}
}

export function getLanguageClient(): LanguageClient | undefined {
	return languageClient;
}

export function getLastLanguageClientError(): string | undefined {
	return lastLanguageClientError;
}

export async function ensureLanguageClientStarted(): Promise<LanguageClient | undefined> {
	if (!languageClient) {
		return undefined;
	}

	if (languageClient.needsStart()) {
		try {
			await languageClient.start();
			lastLanguageClientError = undefined;
		} catch (error) {
			const message = toErrorMessage(error, 'Failed to ensure DDSL Language Server is started.');
			lastLanguageClientError = message;
			clientOutputChannel?.appendLine(`Language client ensure-start failed: ${message}`);
			return undefined;
		}
	}

	return languageClient;
}

export async function stopLanguageClient(): Promise<void> {
	if (languageClient) {
		await languageClient.stop();
		languageClient = undefined;
	}
}

function stateToString(state: State): string {
	switch (state) {
		case State.Starting:
			return 'Starting';
		case State.Running:
			return 'Running';
		case State.Stopped:
			return 'Stopped';
		default:
			return 'Unknown';
	}
}

async function resolveServerBinary(context: vscode.ExtensionContext): Promise<string | undefined> {
	const binaryName = process.platform === 'win32' ? 'ddsl-lsp.exe' : 'ddsl-lsp';
	const binaryPath = context.asAbsolutePath(path.join('bin', binaryName));

	try {
		if (process.platform === 'win32') {
			await access(binaryPath, fsConstants.F_OK);
		} else {
			await access(binaryPath, fsConstants.F_OK | fsConstants.X_OK);
		}
		return binaryPath;
	} catch {
		return undefined;
	}
}

async function resolveServerLaunch(context: vscode.ExtensionContext): Promise<ServerLaunchConfig | undefined> {
	const env = await readEnvironment(context);
	if (env === 'dev') {
		const devJar = '/home/ndhien/dev/ddsl/ddsl-lsp-server/build/libs/ddsl-lsp.jar';
		try {
			await access(devJar, fsConstants.F_OK);
			const configOutputDir = '/home/ndhien/dev/ddsl/ddsl-lsp-server/src/main/resources/META-INF/native-image/uet.ndh/ddsl-lsp';
			return {
				command: '/home/ndhien/.sdkman/candidates/java/current/bin/java',
				args: [
					`-agentlib:native-image-agent=config-output-dir=${configOutputDir}`,
					'-jar',
					devJar,
				],
				label: `/home/ndhien/.sdkman/candidates/java/current/bin/java -agentlib:native-image-agent=config-output-dir=${configOutputDir} -jar ${devJar}`,
			};
		} catch {
			lastLanguageClientError = `ENV=dev but jar not found at ${devJar}`;
			return undefined;
		}
	}

	const binaryPath = await resolveServerBinary(context);
	if (!binaryPath) {
		return undefined;
	}

	return {
		command: binaryPath,
		label: binaryPath,
	};
}

async function readEnvironment(context: vscode.ExtensionContext): Promise<string> {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const candidates = [
		workspaceRoot ? path.join(workspaceRoot, '.env') : undefined,
		context.asAbsolutePath('.env'),
	].filter((value): value is string => Boolean(value));

	for (const filePath of candidates) {
		try {
			const content = await readFile(filePath, 'utf8');
			for (const rawLine of content.split(/\r?\n/)) {
				const line = rawLine.trim();
				if (!line || line.startsWith('#')) {
					continue;
				}

				const separatorIndex = line.indexOf('=');
				if (separatorIndex <= 0) {
					continue;
				}

				const key = line.slice(0, separatorIndex).trim();
				let value = line.slice(separatorIndex + 1).trim();
				if (
					(value.startsWith('"') && value.endsWith('"')) ||
					(value.startsWith("'") && value.endsWith("'"))
				) {
					value = value.slice(1, -1);
				}

				if (key === 'ENV') {
					return value.toLowerCase();
				}
			}
		} catch {
			// Ignore missing/unreadable env files and continue to fallback.
		}
	}

	return 'prod';
}
