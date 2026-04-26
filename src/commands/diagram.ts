import * as vscode from 'vscode';
import { ensureLanguageClientStarted } from '../lsp';
import { toErrorMessage } from '../shared/errors';

const SERVER_COMMANDS = {
	component: 'ddsl.generateComponentDiagram',
	eventFlow: 'ddsl.generateEventFlowDiagram',
} as const;

type DiagramKind = 'component' | 'eventFlow';

type DiagramPayload = {
	mermaid: string;
	sourceUri: string;
	generatedAt: string;
};

type DiagramResponse = {
	success: boolean;
	errors: string[];
	model: unknown;
};

let currentPanel: DiagramPanel | undefined;

export async function runGenerateComponentDiagramCommand(
	context: vscode.ExtensionContext
): Promise<void> {
	await runDiagramCommand(context, 'component');
}

export async function runGenerateEventFlowDiagramCommand(
	context: vscode.ExtensionContext
): Promise<void> {
	await runDiagramCommand(context, 'eventFlow');
}

export async function runGenerateDiagramsCommand(
	context: vscode.ExtensionContext
): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.languageId !== 'ddsl') {
		vscode.window.showWarningMessage('Please open a .ddsl file to generate a diagram.');
		return;
	}

	const languageClient = await ensureLanguageClientStarted();
	if (!languageClient) {
		vscode.window.showErrorMessage('DDSL Language Server is not initialized.');
		return;
	}

	const fileUri = editor.document.uri.toString();

	try {
		const panel = getOrCreatePanel(context);
		const generatedAt = new Date().toISOString();

		const [componentRawResponse, eventRawResponse] = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Generating diagrams...',
			},
			async () => {
				const component = await languageClient.sendRequest('workspace/executeCommand', {
					command: SERVER_COMMANDS.component,
					arguments: [{ uri: fileUri }],
				});

				const eventFlow = await languageClient.sendRequest('workspace/executeCommand', {
					command: SERVER_COMMANDS.eventFlow,
					arguments: [{ uri: fileUri }],
				});

				return [component, eventFlow] as const;
			}
		);

		const componentParsed = parseDiagramResponse(componentRawResponse);
		if (!componentParsed.success || componentParsed.model === undefined || componentParsed.model === null) {
			const details = componentParsed.errors.length > 0
				? componentParsed.errors.join(' | ')
				: 'Component diagram response is invalid.';
			vscode.window.showErrorMessage(`Diagram generation failed: ${details}`);
			return;
		}

		const eventParsed = parseDiagramResponse(eventRawResponse);
		if (!eventParsed.success || eventParsed.model === undefined || eventParsed.model === null) {
			const details = eventParsed.errors.length > 0
				? eventParsed.errors.join(' | ')
				: 'Event flow diagram response is invalid.';
			vscode.window.showErrorMessage(`Diagram generation failed: ${details}`);
			return;
		}

		panel.show(
			'component',
			{
				mermaid: toComponentMermaid(componentParsed.model),
				sourceUri: fileUri,
				generatedAt,
			},
			{ activateTab: true }
		);

		panel.show(
			'eventFlow',
			{
				mermaid: toEventFlowMermaid(eventParsed.model),
				sourceUri: fileUri,
				generatedAt,
			},
			{ activateTab: false }
		);
	} catch (error) {
		vscode.window.showErrorMessage(
			`Diagram generation failed: ${toErrorMessage(error, 'Unknown error from language server.')}`
		);
	}
}

async function runDiagramCommand(
	context: vscode.ExtensionContext,
	kind: DiagramKind
): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.document.languageId !== 'ddsl') {
		vscode.window.showWarningMessage('Please open a .ddsl file to generate a diagram.');
		return;
	}

	const languageClient = await ensureLanguageClientStarted();
	if (!languageClient) {
		vscode.window.showErrorMessage('DDSL Language Server is not initialized.');
		return;
	}

	const fileUri = editor.document.uri.toString();
	const command = kind === 'component' ? SERVER_COMMANDS.component : SERVER_COMMANDS.eventFlow;

	try {
		const rawResponse = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title:
					kind === 'component'
						? 'Generating component diagram...'
						: 'Generating event flow diagram...',
			},
			() =>
				languageClient.sendRequest('workspace/executeCommand', {
					command,
					arguments: [{ uri: fileUri }],
				})
		);

		const parsed = parseDiagramResponse(rawResponse);
		if (!parsed.success) {
			const details = parsed.errors.length > 0 ? parsed.errors.join(' | ') : 'Unknown server error.';
			vscode.window.showErrorMessage(`Diagram generation failed: ${details}`);
			return;
		}

		if (parsed.model === undefined || parsed.model === null) {
			vscode.window.showErrorMessage('Diagram generation failed: response model is empty.');
			return;
		}

		const mermaid =
			kind === 'component'
				? toComponentMermaid(parsed.model)
				: toEventFlowMermaid(parsed.model);

		const payload: DiagramPayload = {
			mermaid,
			sourceUri: fileUri,
			generatedAt: new Date().toISOString(),
		};

		getOrCreatePanel(context).show(kind, payload);
	} catch (error) {
		vscode.window.showErrorMessage(
			`Diagram generation failed: ${toErrorMessage(error, 'Unknown error from language server.')}`
		);
	}
}

function getOrCreatePanel(context: vscode.ExtensionContext): DiagramPanel {
	if (!currentPanel) {
		currentPanel = DiagramPanel.create(context, () => {
			currentPanel = undefined;
		});
	}

	return currentPanel;
}

function parseDiagramResponse(response: unknown): DiagramResponse {
	if (response === null || response === undefined) {
		return {
			success: false,
			errors: ['Server returned an empty response.'],
			model: undefined,
		};
	}

	if (typeof response !== 'object') {
		return {
			success: false,
			errors: [`Unexpected response type: ${typeof response}`],
			model: undefined,
		};
	}

	const record = response as Record<string, unknown>;
	const nested = getObject(record.data);
	const successValue =
		typeof record.success === 'boolean'
			? record.success
			: typeof nested?.success === 'boolean'
				? nested.success
				: undefined;

	const errors = normalizeErrors(record.errors ?? nested?.errors ?? nested?.error ?? record.error);
	const model = record.model ?? nested?.model ?? nested?.diagram ?? record.diagram ?? nested ?? undefined;

	const success =
		successValue !== undefined
			? successValue
			: errors.length === 0 && model !== undefined && model !== null;

	return { success, errors, model };
}

function getObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function normalizeErrors(value: unknown): string[] {
	if (!value) {
		return [];
	}

	if (typeof value === 'string') {
		return [value];
	}

	if (Array.isArray(value)) {
		return value
			.map((item) => {
				if (typeof item === 'string') {
					return item;
				}

				if (item && typeof item === 'object') {
					const record = item as Record<string, unknown>;
					if (typeof record.message === 'string') {
						return record.message;
					}
				}

				return String(item);
			})
			.filter((item) => item.trim().length > 0);
	}

	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		if (typeof record.message === 'string') {
			return [record.message];
		}
	}

	return [String(value)];
}

function toComponentMermaid(model: unknown): string {
	const graph = extractGraphModel(model);
	if (graph.nodes.length === 0) {
		return [
			'flowchart LR',
			'  root["DDSL Model"]',
			'  note["No component nodes found in server model"]',
			'  root --> note',
		].join('\n');
	}

	const lines: string[] = ['flowchart LR'];
	for (const node of graph.nodes) {
		const title = sanitizeMermaidLabel(node.type ? `${node.label}\\n${node.type}` : node.label);
		lines.push(`  ${node.id}["${title}"]`);
	}

	if (graph.edges.length === 0 && graph.nodes.length > 1) {
		for (let i = 1; i < graph.nodes.length; i += 1) {
			lines.push(`  ${graph.nodes[0].id} --> ${graph.nodes[i].id}`);
		}
	} else {
		for (const edge of graph.edges) {
			const label = edge.label ? sanitizeMermaidLabel(edge.label) : '';
			lines.push(
				label
					? `  ${edge.fromId} -->|${label}| ${edge.toId}`
					: `  ${edge.fromId} --> ${edge.toId}`
			);
		}
	}

	return lines.join('\n');
}

function toEventFlowMermaid(model: unknown): string {
	const flows = extractFlowModel(model);
	if (flows.length === 0) {
		return [
			'sequenceDiagram',
			'  participant Domain',
			'  participant Consumer',
			'  Domain->>Consumer: No event flow found in server model',
		].join('\n');
	}

	const participants = new Set<string>();
	for (const flow of flows) {
		participants.add(flow.from);
		participants.add(flow.to);
	}

	const lines: string[] = ['sequenceDiagram', '  autonumber'];
	for (const participant of participants) {
		lines.push(`  participant ${sanitizeMermaidIdentifier(participant)}`);
	}

	for (const flow of flows) {
		const from = sanitizeMermaidIdentifier(flow.from);
		const to = sanitizeMermaidIdentifier(flow.to);
		const label = sanitizeMermaidLabel(flow.label);
		lines.push(`  ${from}->>${to}: ${label}`);
	}

	return lines.join('\n');
}

type GraphNode = {
	id: string;
	label: string;
	type?: string;
};

type GraphEdge = {
	fromId: string;
	toId: string;
	label?: string;
};

function extractGraphModel(model: unknown): { nodes: GraphNode[]; edges: GraphEdge[] } {
	const root = getObject(model);
	if (!root) {
		return { nodes: [], edges: [] };
	}

	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	const nodeMap = new Map<string, string>();
	const pendingDependencyEdges: Array<{ fromKey: string; toKey: string }> = [];

	const registerNode = (keys: Array<string | undefined>, label: string, type?: string): string => {
		const normalizedKeys = keys
			.map((key) => key?.trim())
			.filter((key): key is string => Boolean(key));

		for (const key of normalizedKeys) {
			const existing = nodeMap.get(key);
			if (existing) {
				return existing;
			}
		}

		const id = `N${nodes.length + 1}`;
		nodes.push({ id, label, type });
		for (const key of normalizedKeys) {
			nodeMap.set(key, id);
		}
		return id;
	};

	const contextGroup = Array.isArray(root.contexts) ? (root.contexts as unknown[]) : [];
	for (const contextCandidate of contextGroup) {
		const contextObj = getObject(contextCandidate);
		if (!contextObj) {
			continue;
		}

		const contextName =
			readString(contextObj.boundedContext) ??
			readString(contextObj.name) ??
			readString(contextObj.id) ??
			`Context_${nodes.length + 1}`;

		const contextId = registerNode(
			[
				`context:${contextName}`,
				contextName,
			],
			contextName,
			'boundedContext'
		);

		const components = Array.isArray(contextObj.components)
			? (contextObj.components as unknown[])
			: [];

		for (const componentCandidate of components) {
			const componentObj = getObject(componentCandidate);
			if (!componentObj) {
				continue;
			}

			const componentKey =
				readString(componentObj.id) ??
				readString(componentObj.name) ??
				readString(componentObj.key) ??
				`${contextName}_component_${nodes.length + 1}`;
			const componentName =
				readString(componentObj.name) ?? readString(componentObj.label) ?? componentKey;
			const componentType = readString(componentObj.type) ?? 'component';

			const componentId = registerNode(
				[
					`component:${contextName}:${componentKey}`,
					componentKey,
					componentName,
				],
				componentName,
				componentType
			);

			edges.push({ fromId: contextId, toId: componentId, label: 'contains' });

			if (Array.isArray(componentObj.dependencies)) {
				for (const dependencyCandidate of componentObj.dependencies as unknown[]) {
					if (typeof dependencyCandidate === 'string' && dependencyCandidate.trim().length > 0) {
						pendingDependencyEdges.push({
							fromKey: componentKey,
							toKey: dependencyCandidate.trim(),
						});
						continue;
					}

					const dependencyObj = getObject(dependencyCandidate);
					if (!dependencyObj) {
						continue;
					}

					const dependencyKey =
						readString(dependencyObj.id) ??
						readString(dependencyObj.name) ??
						readString(dependencyObj.target) ??
						readString(dependencyObj.to);

					if (!dependencyKey) {
						continue;
					}

					pendingDependencyEdges.push({
						fromKey: componentKey,
						toKey: dependencyKey,
					});
				}
			}
		}
	}

	const rawNodeGroups = [
		root.nodes,
		root.components,
		root.elements,
		root.entities,
		root.aggregates,
		root.services,
		root.boundedContexts,
	].filter(Array.isArray);

	for (const group of rawNodeGroups) {
		for (const candidate of group as unknown[]) {
			const objectCandidate = getObject(candidate);
			if (!objectCandidate) {
				continue;
			}

			const rawKey =
				readString(objectCandidate.id) ??
				readString(objectCandidate.name) ??
				readString(objectCandidate.key) ??
				`node_${nodes.length + 1}`;
			const label =
				readString(objectCandidate.name) ?? readString(objectCandidate.label) ?? rawKey;
			const type = readString(objectCandidate.type);

			registerNode([rawKey, label], label, type);
		}
	}

	const rawEdgeGroups = [
		root.edges,
		root.relationships,
		root.relations,
		root.links,
		root.dependencies,
	].filter(Array.isArray);

	for (const group of rawEdgeGroups) {
		for (const candidate of group as unknown[]) {
			const objectCandidate = getObject(candidate);
			if (!objectCandidate) {
				continue;
			}

			const fromKey =
				readString(objectCandidate.source) ??
				readString(objectCandidate.from) ??
				readString(objectCandidate.origin);
			const toKey =
				readString(objectCandidate.target) ??
				readString(objectCandidate.to) ??
				readString(objectCandidate.destination);

			if (!fromKey || !toKey) {
				continue;
			}

			const fromId = nodeMap.get(fromKey);
			const toId = nodeMap.get(toKey);
			if (!fromId || !toId) {
				continue;
			}

			edges.push({
				fromId,
				toId,
				label:
					readString(objectCandidate.label) ??
					readString(objectCandidate.type) ??
					readString(objectCandidate.event),
			});
		}
	}

	for (const pendingEdge of pendingDependencyEdges) {
		const fromId = nodeMap.get(pendingEdge.fromKey);
		const toId = nodeMap.get(pendingEdge.toKey);
		if (!fromId || !toId) {
			continue;
		}

		edges.push({ fromId, toId, label: 'depends on' });
	}

	if (nodes.length === 0) {
		const fallbackEntries = Object.entries(root).filter(([, value]) => Array.isArray(value));
		for (const [key, value] of fallbackEntries) {
			if ((value as unknown[]).length === 0) {
				continue;
			}

			const id = `N${nodes.length + 1}`;
			nodes.push({ id, label: key, type: 'group' });
		}
	}

	return { nodes, edges };
}

type EventFlow = {
	from: string;
	to: string;
	label: string;
};

function extractFlowModel(model: unknown): EventFlow[] {
	const root = getObject(model);
	if (!root) {
		return [];
	}

	const groups = [root.flows, root.events, root.messages, root.transitions, root.edges].filter(Array.isArray);
	const flows: EventFlow[] = [];

	for (const group of groups) {
		for (const candidate of group as unknown[]) {
			const objectCandidate = getObject(candidate);
			if (!objectCandidate) {
				continue;
			}

			const from =
				readString(objectCandidate.from) ??
				readString(objectCandidate.source) ??
				readString(objectCandidate.actor) ??
				'Domain';
			const to =
				readString(objectCandidate.to) ??
				readString(objectCandidate.target) ??
				readString(objectCandidate.consumer) ??
				'Domain';
			const label =
				readString(objectCandidate.event) ??
				readString(objectCandidate.label) ??
				readString(objectCandidate.name) ??
				'event';

			flows.push({ from, to, label });
		}
	}

	return flows;
}

function readString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function sanitizeMermaidIdentifier(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		return 'Node';
	}

	let cleaned = trimmed.replace(/[^a-zA-Z0-9_]/g, '_');
	if (!/^[a-zA-Z_]/.test(cleaned)) {
		cleaned = `N_${cleaned}`;
	}

	return cleaned;
}

function sanitizeMermaidLabel(value: string): string {
	return value.replace(/"/g, '\\"').replace(/\n/g, ' ');
}

class DiagramPanel {
	private componentDiagram: DiagramPayload | undefined;
	private eventFlowDiagram: DiagramPayload | undefined;
	private activeTab: DiagramKind = 'component';

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly panel: vscode.WebviewPanel,
		onDispose: () => void
	) {
		this.panel.onDidDispose(onDispose);
	}

	public static create(
		context: vscode.ExtensionContext,
		onDispose: () => void
	): DiagramPanel {
		const panel = vscode.window.createWebviewPanel(
			'ddslDiagrams',
			'DDSL Diagrams',
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [
					vscode.Uri.joinPath(context.extensionUri, 'node_modules', 'mermaid', 'dist'),
					context.extensionUri,
				],
			}
		);

		return new DiagramPanel(context, panel, onDispose);
	}

	public show(
		kind: DiagramKind,
		payload: DiagramPayload,
		options?: { activateTab?: boolean }
	): void {
		if (kind === 'component') {
			this.componentDiagram = payload;
		} else {
			this.eventFlowDiagram = payload;
		}

		if (options?.activateTab !== false) {
			this.activeTab = kind;
		}

		this.panel.title =
			this.activeTab === 'component' ? 'DDSL Component Diagram' : 'DDSL Event Flow Diagram';
		this.panel.webview.html = this.renderHtml(this.activeTab);
		this.panel.reveal(vscode.ViewColumn.Beside, false);
	}

	private renderHtml(activeTab: DiagramKind): string {
		const webview = this.panel.webview;
		const nonce = createNonce();
		const mermaidScriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js')
		);

		const state = {
			activeTab,
			component: this.componentDiagram,
			eventFlow: this.eventFlowDiagram,
		};

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');

		return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DDSL Diagrams</title>
  <style>
    :root {
      --bg: #f8fafc;
      --bg-panel: #ffffff;
      --text: #0f172a;
      --muted: #475569;
      --border: #cbd5e1;
      --tab: #e2e8f0;
      --tab-active: #0f766e;
      --tab-active-text: #ecfeff;
      --shadow: rgba(15, 23, 42, 0.08);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--text);
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      background: radial-gradient(circle at 20% 20%, #e2e8f0 0%, var(--bg) 45%, #eef2ff 100%);
      display: flex;
      justify-content: center;
      padding: 24px;
    }

    .app {
      width: min(1200px, 100%);
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 14px;
      box-shadow: 0 20px 40px var(--shadow);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      min-height: calc(100vh - 48px);
    }

    .header {
      padding: 18px 20px;
      border-bottom: 1px solid var(--border);
      background: linear-gradient(135deg, #f0fdfa 0%, #f8fafc 100%);
    }

    .title {
      margin: 0;
      font-size: 1.2rem;
      font-weight: 700;
      letter-spacing: 0.01em;
    }

    .meta {
      margin-top: 6px;
      color: var(--muted);
      font-size: 0.86rem;
      word-break: break-all;
    }

    .tabs {
      display: flex;
      gap: 8px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      background: #f8fafc;
    }

    .tab {
      border: 1px solid transparent;
      border-radius: 999px;
      background: var(--tab);
      color: #0f172a;
      padding: 8px 14px;
      font-weight: 600;
      font-size: 0.88rem;
      cursor: pointer;
      transition: all 120ms ease;
    }

    .tab:hover {
      transform: translateY(-1px);
      border-color: var(--border);
    }

    .tab.active {
      background: var(--tab-active);
      color: var(--tab-active-text);
      border-color: #0f766e;
    }

    .content {
      padding: 18px;
      flex: 1;
      overflow: auto;
    }

    .diagram-wrap {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: #ffffff;
      min-height: 420px;
      padding: 16px;
      overflow: auto;
    }

    .empty {
      color: var(--muted);
      font-style: italic;
      padding: 20px;
      border: 1px dashed var(--border);
      border-radius: 10px;
      background: #f8fafc;
    }

    .mermaid-source {
      margin-top: 14px;
      background: #0b1022;
      color: #dbeafe;
      border-radius: 10px;
      padding: 12px;
      font-family: "IBM Plex Mono", "Cascadia Mono", monospace;
      font-size: 0.78rem;
      overflow: auto;
      max-height: 180px;
      white-space: pre;
    }

    @media (max-width: 860px) {
      body { padding: 10px; }
      .app { min-height: calc(100vh - 20px); }
      .tabs { flex-wrap: wrap; }
      .tab { flex: 1 1 220px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <div class="header">
      <h1 class="title">DDSL Diagram Studio</h1>
      <div id="meta" class="meta"></div>
    </div>
    <div class="tabs">
      <button id="tab-component" class="tab" data-tab="component" type="button">Component Diagram</button>
      <button id="tab-eventFlow" class="tab" data-tab="eventFlow" type="button">Event Flow Diagram</button>
    </div>
    <div class="content">
      <div id="diagram" class="diagram-wrap"></div>
      <div id="mermaid-source" class="mermaid-source" hidden></div>
    </div>
  </div>

  <script nonce="${nonce}" src="${mermaidScriptUri}"></script>
  <script nonce="${nonce}">
    const state = ${JSON.stringify(state)};
    let activeTab = state.activeTab || 'component';

    const tabComponent = document.getElementById('tab-component');
    const tabEventFlow = document.getElementById('tab-eventFlow');
    const diagramEl = document.getElementById('diagram');
    const sourceEl = document.getElementById('mermaid-source');
    const metaEl = document.getElementById('meta');

    const diagramMap = {
      component: state.component,
      eventFlow: state.eventFlow,
    };

    tabComponent.addEventListener('click', () => {
      activeTab = 'component';
      render();
    });

    tabEventFlow.addEventListener('click', () => {
      activeTab = 'eventFlow';
      render();
    });

    function escapeHtml(value) {
      return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    async function render() {
      tabComponent.classList.toggle('active', activeTab === 'component');
      tabEventFlow.classList.toggle('active', activeTab === 'eventFlow');

      const current = diagramMap[activeTab];
      if (!current || !current.mermaid) {
        diagramEl.innerHTML = '<div class="empty">Run the selected diagram command to generate and render Mermaid content.</div>';
        sourceEl.hidden = true;
        metaEl.textContent = 'No diagram available yet.';
        return;
      }

      const generatedAt = new Date(current.generatedAt).toLocaleString();
		metaEl.textContent = 'Source: ' + current.sourceUri + ' | Generated: ' + generatedAt;

		diagramEl.innerHTML = '<pre class="mermaid">' + escapeHtml(current.mermaid) + '</pre>';
      sourceEl.textContent = current.mermaid;
      sourceEl.hidden = false;

      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          sequence: {
            actorMargin: 50,
            width: 180,
            messageMargin: 36,
          },
          flowchart: {
            curve: 'basis',
            htmlLabels: true,
          },
        });
		const mermaidNode = diagramEl.querySelector('.mermaid');
		if (!mermaidNode) {
			throw new Error('Mermaid node was not created.');
		}
		await mermaid.run({ nodes: [mermaidNode] });
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
		diagramEl.innerHTML = '<div class="empty">Failed to render Mermaid: ' + escapeHtml(message) + '</div>';
      }
    }

    render();
  </script>
</body>
</html>`;
	}
}

function createNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let value = '';
	for (let index = 0; index < 32; index += 1) {
		value += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return value;
}