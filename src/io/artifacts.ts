import * as vscode from 'vscode';
import * as path from 'node:path';

export async function persistCompileArtifact(
	documentUri: vscode.Uri,
	response: unknown
): Promise<vscode.Uri | undefined> {
	const outputRoot = getOutputRootUri(documentUri);
	if (!outputRoot) {
		return undefined;
	}

	const runId = createRunId();
	const runDir = vscode.Uri.joinPath(outputRoot, getConfiguredOutputDirName(), 'compile', runId);
	await vscode.workspace.fs.createDirectory(runDir);

	const summaryUri = vscode.Uri.joinPath(runDir, 'compile-result.json');
	const summary = {
		createdAt: new Date().toISOString(),
		source: documentUri.toString(),
		response,
	};

	await vscode.workspace.fs.writeFile(
		summaryUri,
		Buffer.from(JSON.stringify(summary, null, 2), 'utf8')
	);

	const outputCandidate = extractOutputCandidate(response);
	if (outputCandidate) {
		const outputUri = toUri(outputCandidate, documentUri);
		if (outputUri && (await exists(outputUri))) {
			try {
				const bytes = await vscode.workspace.fs.readFile(outputUri);
				const targetUri = vscode.Uri.joinPath(
					runDir,
					path.basename(outputUri.fsPath) || 'compile-output.bin'
				);
				await vscode.workspace.fs.writeFile(targetUri, bytes);
			} catch {
				// Ignore output copy errors, keep summary artifact as guaranteed output.
			}
		}
	}

	return summaryUri;
}

export async function createAiDiffFiles(
	documentUri: vscode.Uri,
	beforeContent: string,
	afterContent: string,
	prompt: string
): Promise<{ before: vscode.Uri; after: vscode.Uri }> {
	const outputRoot = getOutputRootUri(documentUri);
	if (outputRoot) {
		const runId = createRunId();
		const runDir = vscode.Uri.joinPath(outputRoot, getConfiguredOutputDirName(), 'ai-diff', runId);
		await vscode.workspace.fs.createDirectory(runDir);

		const beforeUri = vscode.Uri.joinPath(runDir, 'before.ddsl');
		const afterUri = vscode.Uri.joinPath(runDir, 'after.ddsl');
		const promptUri = vscode.Uri.joinPath(runDir, 'prompt.txt');

		await vscode.workspace.fs.writeFile(beforeUri, Buffer.from(beforeContent, 'utf8'));
		await vscode.workspace.fs.writeFile(afterUri, Buffer.from(afterContent, 'utf8'));
		await vscode.workspace.fs.writeFile(promptUri, Buffer.from(prompt, 'utf8'));

		return { before: beforeUri, after: afterUri };
	}

	const beforeDoc = await vscode.workspace.openTextDocument({
		language: 'ddsl',
		content: beforeContent,
	});
	const afterDoc = await vscode.workspace.openTextDocument({
		language: 'ddsl',
		content: afterContent,
	});

	return { before: beforeDoc.uri, after: afterDoc.uri };
}

export function extractOutputCandidate(response: unknown): string | undefined {
	if (typeof response === 'string') {
		return response;
	}

	if (!response || typeof response !== 'object') {
		return undefined;
	}

	const payload = response as Record<string, unknown>;
	const candidate =
		typeof payload.outputUri === 'string'
			? payload.outputUri
			: typeof payload.outputPath === 'string'
				? payload.outputPath
				: typeof payload.file === 'string'
					? payload.file
					: undefined;

	return candidate?.trim();
}

function getConfiguredOutputDirName(): string {
	const configured = vscode.workspace
		.getConfiguration('ddsl.compile')
		.get<string>('outputDir', '.ddsl-output')
		.trim();

	return configured || '.ddsl-output';
}

function getOutputRootUri(documentUri: vscode.Uri): vscode.Uri | undefined {
	const fromDocument = vscode.workspace.getWorkspaceFolder(documentUri)?.uri;
	if (fromDocument) {
		return fromDocument;
	}

	const firstWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (firstWorkspace) {
		return firstWorkspace;
	}

	if (documentUri.scheme === 'file') {
		return vscode.Uri.file(path.dirname(documentUri.fsPath));
	}

	return undefined;
}

function toUri(candidate: string, baseDocumentUri: vscode.Uri): vscode.Uri | undefined {
	const value = candidate.trim();
	if (!value) {
		return undefined;
	}

	if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value)) {
		return vscode.Uri.parse(value);
	}

	if (path.isAbsolute(value)) {
		return vscode.Uri.file(value);
	}

	const workspaceRoot = getOutputRootUri(baseDocumentUri);
	if (!workspaceRoot || workspaceRoot.scheme !== 'file') {
		return undefined;
	}

	return vscode.Uri.file(path.join(workspaceRoot.fsPath, value));
}

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

function createRunId(): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${stamp}-${suffix}`;
}
