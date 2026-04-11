import * as vscode from 'vscode';
import { runAiGenerationCommand } from './commands/ai';
import { runCompileCommand } from './commands/compile';
import {
	getLastLanguageClientError,
	startLanguageClient,
	stopLanguageClient,
} from './lsp';

const EXTENSION_COMMANDS = {
	compile: 'ddsl.compileAction',
	generateAi: 'ddsl.generateAI',
} as const;

export async function activate(context: vscode.ExtensionContext) {
	const outputChannel = vscode.window.createOutputChannel('DDSL Language Server');
	context.subscriptions.push(outputChannel);

	const binaryPath = await startLanguageClient(context, outputChannel);
	if (!binaryPath) {
		const startupError = getLastLanguageClientError();
		if (startupError) {
			vscode.window.showErrorMessage(
				`DDSL Language Server failed to start: ${startupError}`
			);
		} else {
			vscode.window.showErrorMessage(
				'Cannot find or execute the DDSL Language Server binary at bin/ddsl-lsp.'
			);
		}
		return;
	}

	await registerCommandSafely(
		context,
		outputChannel,
		EXTENSION_COMMANDS.compile,
		async () => {
			await runCompileCommand();
		}
	);

	await registerCommandSafely(
		context,
		outputChannel,
		EXTENSION_COMMANDS.generateAi,
		async () => {
			await runAiGenerationCommand();
		}
	);

	outputChannel.appendLine('DDSL extension activated.');
	outputChannel.appendLine(`Using server launch: ${binaryPath}`);
	outputChannel.appendLine('DDSL Language Server is ready.');

	vscode.window.showInformationMessage('DDSL tools are ready.');
}

export async function deactivate(): Promise<void> {
	await stopLanguageClient();
}

async function registerCommandSafely(
	context: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
	command: string,
	handler: (...args: unknown[]) => unknown
): Promise<void> {
	try {
		context.subscriptions.push(vscode.commands.registerCommand(command, handler));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes('already exists')) {
			outputChannel.appendLine(
				`Skipping command registration for ${command} because it is already registered.`
			);
			return;
		}

		throw error;
	}
}
