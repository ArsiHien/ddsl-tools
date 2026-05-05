import * as vscode from 'vscode';
import * as path from 'node:path';
import { createAiDiffFiles } from '../io/artifacts';
import { toErrorMessage } from '../shared/errors';

class AIContentProvider implements vscode.TextDocumentContentProvider {
	static scheme = 'ddsl-ai-preview';
	private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.onDidChangeEmitter.event;
	private content = '';

	update(uri: vscode.Uri, content: string): void {
		this.content = content;
		this.onDidChangeEmitter.fire(uri);
	}

	provideTextDocumentContent(): string {
		return this.content;
	}
}

const aiProvider = new AIContentProvider();

export function registerAiPreviewProvider(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(AIContentProvider.scheme, aiProvider)
	);
}

export async function runAiGenerationCommand(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		vscode.window.showWarningMessage('No active editor is open to insert DDSL code.');
		return;
	}

	// Automatically call the AI endpoint with an empty prompt when invoked.
	// No user input is required.
	const input = '';

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
		const currentContent = currentDocument.getText();

		await createAiDiffFiles(
			currentDocument.uri,
			currentContent,
			generatedCode,
			input.trim()
		);

		const baseName = path.basename(currentDocument.fileName);
		const previewName = `${baseName || 'ddsl'}-ai.ddsl`;
		const previewUri = vscode.Uri.parse(
			`${AIContentProvider.scheme}:${encodeURIComponent(previewName)}`
		);
		aiProvider.update(previewUri, generatedCode);

		await vscode.workspace
			.getConfiguration('diffEditor')
			.update('renderSideBySide', true, vscode.ConfigurationTarget.Workspace);

		await vscode.commands.executeCommand(
			'vscode.diff',
			currentDocument.uri,
			previewUri,
			`${baseName || 'DDSL'} ↔ AI Generated`,
			{ preview: true, viewColumn: vscode.ViewColumn.Active }
		);

		const choice = await vscode.window.showInformationMessage(
			'Apply AI generated changes to the current file?',
			'Apply',
			'Cancel'
		);
		if (choice === 'Apply') {
			await applyGeneratedCode(currentDocument, generatedCode);
		}
	} catch (error) {
		vscode.window.showErrorMessage(
			`AI generation failed: ${toErrorMessage(error, 'Unknown error.')}`
		);
	}
}

async function applyGeneratedCode(
	document: vscode.TextDocument,
	content: string
): Promise<void> {
	const fullRange = new vscode.Range(
		document.positionAt(0),
		document.positionAt(document.getText().length)
	);
	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, fullRange, content);
	await vscode.workspace.applyEdit(edit);
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

	// Development mode: return mock response for UI testing
	const mockResponse = {
		dsl: 'BoundedContext HotelManagement {\n  Aggregate Reservation {\n    AggregateRoot ReservationRoot {\n      Identity reservationId\n      field guestName: String\n      field roomType: String\n      field checkInDate: Date\n      field checkOutDate: Date\n    }\n    Entity Guest {\n      field name: String\n      field email: String\n    }\n    DomainEvent ReservationCreated {\n      field reservationId: UUID\n      field guestName: String\n    }\n  }\n  Service ReservationService {\n    Command CreateReservation\n    Command CancelReservation\n  }\n}'
	};
	const code = extractDslFromAiResponse(mockResponse);
	if (code.trim()) {
		vscode.window.showInformationMessage('[DEV] Using mock AI response');
		return code;
	}


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
