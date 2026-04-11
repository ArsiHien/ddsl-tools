import * as vscode from 'vscode';
import * as path from 'node:path';
import { ensureLanguageClientStarted } from '../lsp';
import { extractOutputCandidate, persistCompileArtifact } from '../io/artifacts';
import { toErrorMessage } from '../shared/errors';

const SERVER_COMMANDS = {
	compile: 'ddsl.compile',
} as const;

const COMPILE_REQUEST_TIMEOUT_MS = 30000;

export async function runCompileCommand(): Promise<void> {
	const languageClient = await ensureLanguageClientStarted();
	if (!languageClient) {
		vscode.window.showErrorMessage('DDSL Language Server is not initialized.');
		return;
	}

	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.languageId !== 'ddsl') {
		vscode.window.showWarningMessage('Please open a .ddsl file to run Compile.');
		return;
	}

	try {
		const documentUri = editor.document.uri.toString();
		const response = await requestCompileWithTimeout(
			languageClient.sendRequest('workspace/executeCommand', {
				command: SERVER_COMMANDS.compile,
				arguments: [
					documentUri,
					{ basePackage: 'com.example.domain' },
				],
			}),
			COMPILE_REQUEST_TIMEOUT_MS
		);

		const artifactUri = await persistCompileArtifact(editor.document.uri, response);

		await handleCompileResponse(response);

		if (artifactUri) {
			vscode.window.showInformationMessage(
				`Compile artifact created: ${artifactUri.fsPath}`
			);
		}
	} catch (error) {
		if (isCompileTimeoutError(error)) {
			vscode.window.showWarningMessage(
				`Compile request is still running after ${COMPILE_REQUEST_TIMEOUT_MS / 1000}s. Check the DDSL output logs for progress.`
			);
			return;
		}

		vscode.window.showErrorMessage(
			`Compile failed: ${toErrorMessage(error, 'Unknown error from the language server.')}`
		);
	}
}

function requestCompileWithTimeout<T>(
	request: Promise<T>,
	timeoutMs: number
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error('compile-timeout'));
		}, timeoutMs);

		request.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

function isCompileTimeoutError(error: unknown): boolean {
	return error instanceof Error && error.message === 'compile-timeout';
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
		const outputCandidate = extractOutputCandidate(response);

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
