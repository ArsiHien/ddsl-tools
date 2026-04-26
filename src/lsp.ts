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
		middleware: {
			provideDocumentSymbols: async (document, token, next) => {
				try {
					const result = await next(document, token);
					return sanitizeDocumentSymbolResult(result);
				} catch (error) {
					if (isConnectionDisposedError(error)) {
						clientOutputChannel?.appendLine(
							'Document symbols request skipped because language client connection is disposed.'
						);
						return [];
					}

					throw error;
				}
			},
		},
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

		if (event.newState === State.Stopped) {
			languageClient = undefined;
		}
	});

	try {
		await languageClient.start();
		lastLanguageClientError = undefined;
		const semanticProvider = languageClient.initializeResult?.capabilities.semanticTokensProvider;
		if (semanticProvider) {
			outputChannel.appendLine('Semantic tokens provider: available.');
		} else {
			outputChannel.appendLine(
				'Semantic tokens provider: missing. The server must implement semantic tokens for syntax colors.'
			);
		}
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

	if (languageClient.needsStart() || languageClient.state !== State.Running) {
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

	if (!languageClient.isRunning()) {
		lastLanguageClientError = 'Language client is not running.';
		clientOutputChannel?.appendLine(lastLanguageClientError);
		return undefined;
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

function sanitizeDocumentSymbolResult(
	result: vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined | null
): vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined | null {
	if (!result || result.length === 0) {
		return result;
	}

	if (result[0] instanceof vscode.SymbolInformation) {
		return result;
	}

	return (result as vscode.DocumentSymbol[]).map(sanitizeDocumentSymbol);
}

function sanitizeDocumentSymbol(symbol: vscode.DocumentSymbol): vscode.DocumentSymbol {
	const range = symbol.range;
	const selectionRange = containsRange(range, symbol.selectionRange)
		? symbol.selectionRange
		: range;

	const children = symbol.children?.map(sanitizeDocumentSymbol) ?? [];

	const sanitized = new vscode.DocumentSymbol(
		symbol.name,
		symbol.detail,
		symbol.kind,
		range,
		selectionRange
	);

	sanitized.tags = symbol.tags;
	sanitized.children = children;
	return sanitized;
}

function containsRange(outer: vscode.Range, inner: vscode.Range): boolean {
	return (
		containsPosition(outer, inner.start) &&
		containsPosition(outer, inner.end)
	);
}

function containsPosition(range: vscode.Range, position: vscode.Position): boolean {
	return !position.isBefore(range.start) && !position.isAfter(range.end);
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
			const enableNativeImageAgent =
				(await readEnvironmentValue(context, 'NATIVE_IMAGE_AGENT'))?.toLowerCase() === 'true';
			const args = ['-jar', devJar];
			let label = `/home/ndhien/.sdkman/candidates/java/current/bin/java -jar ${devJar}`;

			if (enableNativeImageAgent) {
				const configOutputDir = '/home/ndhien/dev/ddsl/ddsl-lsp-server/src/main/resources/META-INF/native-image/uet.ndh/ddsl-lsp';
				args.unshift(`-agentlib:native-image-agent=config-output-dir=${configOutputDir}`);
				label = `/home/ndhien/.sdkman/candidates/java/current/bin/java -agentlib:native-image-agent=config-output-dir=${configOutputDir} -jar ${devJar}`;
			}

			return {
				command: '/home/ndhien/.sdkman/candidates/java/current/bin/java',
				args,
				label,
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
	const value = await readEnvironmentValue(context, 'ENV');
	return value ? value.toLowerCase() : 'prod';
}

async function readEnvironmentValue(
	context: vscode.ExtensionContext,
	keyToFind: string
): Promise<string | undefined> {
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

				if (key === keyToFind) {
					return value;
				}
			}
		} catch {
			// Ignore missing/unreadable env files and continue to fallback.
		}
	}

	return undefined;
}

function isConnectionDisposedError(error: unknown): boolean {
	const message = toErrorMessage(error, '').toLowerCase();
	return message.includes('connection got disposed') || message.includes('pending response rejected');
}
