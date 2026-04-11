import * as vscode from 'vscode';
import { createAiDiffFiles } from '../io/artifacts';
import { toErrorMessage } from '../shared/errors';

export async function runAiGenerationCommand(): Promise<void> {
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

		const currentDocument = editor.document;
		const selection = editor.selection;
		const currentContent = currentDocument.getText();
		const startOffset = currentDocument.offsetAt(selection.start);
		const endOffset = currentDocument.offsetAt(selection.end);
		const proposedContent =
			currentContent.slice(0, startOffset) +
			generatedCode +
			currentContent.slice(endOffset);

		const diffUris = await createAiDiffFiles(
			currentDocument.uri,
			currentContent,
			proposedContent,
			input.trim()
		);

		await vscode.commands.executeCommand(
			'vscode.diff',
			diffUris.before,
			diffUris.after,
			'AI Generated DDSL Preview',
			{ preview: false, viewColumn: vscode.ViewColumn.Beside }
		);

		const action = await vscode.window.showInformationMessage(
			'Review the side-by-side diff. Do you want to apply the AI-generated changes?',
			{ modal: true },
			'Apply',
			'Discard'
		);

		if (action !== 'Apply') {
			vscode.window.showInformationMessage('AI-generated changes were discarded.');
			return;
		}

		const inserted = await editor.edit((editBuilder) => {
			if (selection && !selection.isEmpty) {
				editBuilder.replace(selection, generatedCode);
			} else {
				editBuilder.insert(selection.active, generatedCode);
			}
		});

		if (!inserted) {
			throw new Error('Failed to insert DDSL code into the editor.');
		}

		vscode.window.showInformationMessage('Applied AI-generated DDSL changes to the editor.');
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
