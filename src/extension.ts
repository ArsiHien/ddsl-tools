import * as vscode from 'vscode';
import * as path from 'node:path';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
} from 'vscode-languageclient/node';

const EXTENSION_COMMANDS = {
	compile: 'ddsl.compile',
	generateAi: 'ddsl.generateAI',
} as const;

const SERVER_COMMANDS = {
	compile: 'ddsl.compile',
} as const;

let languageClient: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel('DDSL Language Server');
	context.subscriptions.push(outputChannel);

	const binaryPath = await resolveServerBinary(context);
	if (!binaryPath) {
		vscode.window.showErrorMessage(
			'Cannot find or execute the DDSL Language Server binary at bin/ddsl-lsp.'
		);
		return;
	}

	const serverOptions: ServerOptions = {
		run: {
			command: binaryPath,
			transport: TransportKind.stdio,
		},
		debug: {
			command: binaryPath,
			transport: TransportKind.stdio,
		},
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'ddsl' }],
		outputChannel,
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

	await languageClient.start();

	context.subscriptions.push(
		vscode.commands.registerCommand(EXTENSION_COMMANDS.compile, async () => {
			await runCompileCommand();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(EXTENSION_COMMANDS.generateAi, async () => {
			await runAiGenerationCommand();
		})
	);

	outputChannel.appendLine('DDSL extension activated.');
	outputChannel.appendLine(`Using server binary: ${binaryPath}`);
	outputChannel.appendLine('DDSL Language Server is ready.');

	vscode.window.showInformationMessage('DDSL tools are ready.');

	context.subscriptions.push({
		dispose: () => {
			languageClient = undefined;
		},
	});
}

export async function deactivate(): Promise<void> {
	if (languageClient) {
		await languageClient.stop();
		languageClient = undefined;
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

async function runCompileCommand(): Promise<void> {
	if (!languageClient) {
		vscode.window.showErrorMessage('DDSL Language Server is not initialized.');
		return;
	}

	if (languageClient.needsStart()) {
		await languageClient.start();
	}

	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.languageId !== 'ddsl') {
		vscode.window.showWarningMessage('Please open a .ddsl file to run Compile.');
		return;
	}

	try {
		const response = await languageClient.sendRequest('workspace/executeCommand', {
			command: SERVER_COMMANDS.compile,
			arguments: [
				editor.document.uri.toString(),
				editor.document.getText(),
			],
		});

		await handleCompileResponse(response);
	} catch (error) {
		vscode.window.showErrorMessage(
			`Compile failed: ${toErrorMessage(error, 'Unknown error from the language server.')}`
		);
	}
}

async function handleCompileResponse(response: unknown): Promise<void> {
	if (!response) {
		vscode.window.showInformationMessage('Compile completed.');
		return;
	}

	if (typeof response === 'string') {
		const opened = await tryOpenPathOrUri(response);
		if (!opened) {
			vscode.window.showInformationMessage(response);
		}
		return;
	}

	if (typeof response === 'object') {
		const payload = response as Record<string, unknown>;
		const message = typeof payload.message === 'string' ? payload.message : 'Compile completed.';
		const outputCandidate =
			typeof payload.outputUri === 'string'
				? payload.outputUri
				: typeof payload.outputPath === 'string'
					? payload.outputPath
					: typeof payload.file === 'string'
						? payload.file
						: undefined;

		if (outputCandidate) {
			const opened = await tryOpenPathOrUri(outputCandidate);
			if (!opened) {
				vscode.window.showInformationMessage(message);
			}
			return;
		}

		vscode.window.showInformationMessage(message);
		return;
	}

	vscode.window.showInformationMessage('Compile completed.');
}

async function tryOpenPathOrUri(value: string): Promise<boolean> {
	const candidate = value.trim();
	if (!candidate) {
		return false;
	}

	try {
		let uri: vscode.Uri;
		if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(candidate)) {
			uri = vscode.Uri.parse(candidate);
		} else {
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			const absolutePath = path.isAbsolute(candidate)
				? candidate
				: workspaceFolder
					? path.join(workspaceFolder.uri.fsPath, candidate)
					: candidate;
			uri = vscode.Uri.file(absolutePath);
		}

		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { preview: false });
		return true;
	} catch {
		return false;
	}
}

async function runAiGenerationCommand(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('No active editor is open to insert DDSL code.');
		return;
	}

	const input = await vscode.window.showInputBox({
		prompt: 'Enter a natural language prompt to generate DDSL',
		placeHolder: 'Example: Create a User entity with name and email fields',
		ignoreFocusOut: true,
		validateInput: (value) => (value.trim() ? null : 'Prompt cannot be empty.'),
	});

	if (!input?.trim()) {
		return;
	}

	const config = vscode.workspace.getConfiguration('ddsl.ai');
	const baseUrl = (config.get<string>('apiUrl') ?? '').trim();
	const timeoutMs = Math.max(1000, config.get<number>('timeoutMs', 30000));
	const maxRetries = Math.max(0, config.get<number>('maxRetries', 3));

	if (!baseUrl) {
		vscode.window.showErrorMessage('ddsl.ai.apiUrl is not configured.');
		return;
	}

	try {
		const generatedCode = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Generating DDSL from AI...',
				cancellable: true,
			},
			(_, token) =>
				requestAiTranslation({
					baseUrl,
					input: input.trim(),
					timeoutMs,
					maxRetries,
					token,
				})
		);

		const inserted = await editor.edit((editBuilder) => {
			const selection = editor.selection;
			if (selection && !selection.isEmpty) {
				editBuilder.replace(selection, generatedCode);
			} else {
				editBuilder.insert(selection.active, generatedCode);
			}
		});

		if (!inserted) {
			throw new Error('Failed to insert DDSL code into the editor.');
		}

		vscode.window.showInformationMessage('Inserted DDSL code from AI into the editor.');
	} catch (error) {
		vscode.window.showErrorMessage(
			`AI generation failed: ${toErrorMessage(error, 'Unknown error.')}`
		);
	}
}

async function requestAiTranslation(params: {
	baseUrl: string;
	input: string;
	timeoutMs: number;
	maxRetries: number;
	token: vscode.CancellationToken;
}): Promise<string> {
	const { baseUrl, input, timeoutMs, maxRetries, token } = params;
	const endpoint = `${baseUrl.replace(/\/$/, '')}/api/translate`;

	let lastError: unknown;

	for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
		if (token.isCancellationRequested) {
			throw new Error('AI request was canceled.');
		}

		const controller = new AbortController();
		const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
		const cancelSubscription = token.onCancellationRequested(() => controller.abort());

		try {
			const response = await fetch(endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					input,
					maxRetries,
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			const payload = (await response.json()) as unknown;
			const code = extractDslFromAiResponse(payload);
			if (!code.trim()) {
				throw new Error('API did not return valid DDSL code.');
			}

			return code;
		} catch (error) {
			lastError = error;
			if (token.isCancellationRequested) {
				throw new Error('AI request was canceled.');
			}

			if (isAbortError(error)) {
				lastError = new Error(`Timed out after ${timeoutMs}ms while calling AI service.`);
			}

			if (attempt > maxRetries) {
				break;
			}
		} finally {
			clearTimeout(timeoutHandle);
			cancelSubscription.dispose();
		}
	}

	throw lastError instanceof Error ? lastError : new Error('Failed to call AI service.');
}

function extractDslFromAiResponse(payload: unknown): string {
	if (typeof payload === 'string') {
		return payload;
	}

	if (!payload || typeof payload !== 'object') {
		return '';
	}

	const record = payload as Record<string, unknown>;
	const candidates = [
		record.dsl,
		record.code,
		record.result,
		record.output,
		(record.data as Record<string, unknown> | undefined)?.dsl,
		(record.data as Record<string, unknown> | undefined)?.code,
	];

	for (const candidate of candidates) {
		if (typeof candidate === 'string') {
			return candidate;
		}
	}

	return '';
}

function isAbortError(error: unknown): boolean {
	if (!error || typeof error !== 'object') {
		return false;
	}

	return (error as { name?: string }).name === 'AbortError';
}

function toErrorMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}

	return fallback;
}
