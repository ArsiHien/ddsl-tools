import * as vscode from "vscode";
import { ensureLanguageClientStarted } from "../lsp";
import { toErrorMessage } from "../shared/errors";
import {
  DiagramPanel,
  type DiagramKind,
  type DiagramPayload,
} from "./diagram-webview";

const SERVER_COMMANDS = {
  component: "ddsl.generateComponentDiagram",
  eventFlow: "ddsl.generateEventFlowDiagram",
} as const;

type DiagramResponse = {
  success: boolean;
  errors: string[];
  model: unknown;
};

let currentPanel: DiagramPanel | undefined;

export async function runGenerateComponentDiagramCommand(
  context: vscode.ExtensionContext,
): Promise<void> {
  await runDiagramCommand(context, "component");
}

export async function runGenerateEventFlowDiagramCommand(
  context: vscode.ExtensionContext,
): Promise<void> {
  await runDiagramCommand(context, "eventFlow");
}

export async function runGenerateDiagramsCommand(
  context: vscode.ExtensionContext,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "ddsl") {
    vscode.window.showWarningMessage(
      "Please open a .ddsl file to generate a diagram.",
    );
    return;
  }

  const languageClient = await ensureLanguageClientStarted();
  if (!languageClient) {
    vscode.window.showErrorMessage("DDSL Language Server is not initialized.");
    return;
  }

  const fileUri = editor.document.uri.toString();

  try {
    const panel = getOrCreatePanel(context);
    const generatedAt = new Date().toISOString();

    const [componentRawResponse, eventRawResponse] =
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Generating diagrams...",
        },
        async () => {
          const component = await languageClient.sendRequest(
            "workspace/executeCommand",
            {
              command: SERVER_COMMANDS.component,
              arguments: [{ uri: fileUri }],
            },
          );

          const eventFlow = await languageClient.sendRequest(
            "workspace/executeCommand",
            {
              command: SERVER_COMMANDS.eventFlow,
              arguments: [{ uri: fileUri }],
            },
          );

          return [component, eventFlow] as const;
        },
      );

    const componentParsed = parseDiagramResponse(componentRawResponse);
    if (
      !componentParsed.success ||
      componentParsed.model === undefined ||
      componentParsed.model === null
    ) {
      const details =
        componentParsed.errors.length > 0
          ? componentParsed.errors.join(" | ")
          : "Component diagram response is invalid.";
      vscode.window.showErrorMessage(`Diagram generation failed: ${details}`);
      return;
    }

    const eventParsed = parseDiagramResponse(eventRawResponse);
    if (
      !eventParsed.success ||
      eventParsed.model === undefined ||
      eventParsed.model === null
    ) {
      const details =
        eventParsed.errors.length > 0
          ? eventParsed.errors.join(" | ")
          : "Event flow diagram response is invalid.";
      vscode.window.showErrorMessage(`Diagram generation failed: ${details}`);
      return;
    }

    panel.show(
      "component",
      {
        mermaid: toComponentMermaid(componentParsed.model),
        sourceUri: fileUri,
        generatedAt,
      },
      { activateTab: true },
    );

    panel.show(
      "eventFlow",
      {
        mermaid: toEventFlowMermaid(eventParsed.model),
        sourceUri: fileUri,
        generatedAt,
      },
      { activateTab: false },
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Diagram generation failed: ${toErrorMessage(error, "Unknown error from language server.")}`,
    );
  }
}

async function runDiagramCommand(
  context: vscode.ExtensionContext,
  kind: DiagramKind,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "ddsl") {
    vscode.window.showWarningMessage(
      "Please open a .ddsl file to generate a diagram.",
    );
    return;
  }

  const languageClient = await ensureLanguageClientStarted();
  if (!languageClient) {
    vscode.window.showErrorMessage("DDSL Language Server is not initialized.");
    return;
  }

  const fileUri = editor.document.uri.toString();
  const command =
    kind === "component"
      ? SERVER_COMMANDS.component
      : SERVER_COMMANDS.eventFlow;

  try {
    const rawResponse = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title:
          kind === "component"
            ? "Generating component diagram..."
            : "Generating event flow diagram...",
      },
      () =>
        languageClient.sendRequest("workspace/executeCommand", {
          command,
          arguments: [{ uri: fileUri }],
        }),
    );

    const parsed = parseDiagramResponse(rawResponse);
    if (!parsed.success) {
      const details =
        parsed.errors.length > 0
          ? parsed.errors.join(" | ")
          : "Unknown server error.";
      vscode.window.showErrorMessage(`Diagram generation failed: ${details}`);
      return;
    }

    if (parsed.model === undefined || parsed.model === null) {
      vscode.window.showErrorMessage(
        "Diagram generation failed: response model is empty.",
      );
      return;
    }

    const mermaid =
      kind === "component"
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
      `Diagram generation failed: ${toErrorMessage(error, "Unknown error from language server.")}`,
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
      errors: ["Server returned an empty response."],
      model: undefined,
    };
  }

  if (typeof response !== "object") {
    return {
      success: false,
      errors: [`Unexpected response type: ${typeof response}`],
      model: undefined,
    };
  }

  const record = response as Record<string, unknown>;
  const nested = getObject(record.data);
  const successValue =
    typeof record.success === "boolean"
      ? record.success
      : typeof nested?.success === "boolean"
        ? nested.success
        : undefined;

  const errors = normalizeErrors(
    record.errors ?? nested?.errors ?? nested?.error ?? record.error,
  );
  const model =
    record.model ??
    nested?.model ??
    nested?.diagram ??
    record.diagram ??
    nested ??
    undefined;

  const success =
    successValue !== undefined
      ? successValue
      : errors.length === 0 && model !== undefined && model !== null;

  return { success, errors, model };
}

function getObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeErrors(value: unknown): string[] {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          if (typeof record.message === "string") {
            return record.message;
          }
        }

        return String(item);
      })
      .filter((item) => item.trim().length > 0);
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string") {
      return [record.message];
    }
  }

  return [String(value)];
}

function toComponentMermaid(model: unknown): string {
  const graph = extractGraphModel(model);
  if (graph.nodes.length === 0) {
    return [
      "flowchart LR",
      '  root["DDSL Model"]',
      '  note["No component nodes found in server model"]',
      "  root --> note",
    ].join("\n");
  }

  const lines: string[] = ["flowchart LR"];
  const escapeHtml = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  for (const node of graph.nodes) {
    const parts: string[] = [];
    parts.push(`<div style=\"text-align:left\"><strong>${escapeHtml(node.label)}</strong>`);
    if (node.type) {
      parts.push(`<div style=\"font-size:smaller;color:gray\">${escapeHtml(node.type)}</div>`);
    }

    if (node.fields && node.fields.length > 0) {
      parts.push('<hr style=\"margin:4px 0\"/>');
      parts.push(node.fields.map((f) => escapeHtml(f)).join("<br/>"));
    }

    if (node.methods && node.methods.length > 0) {
      parts.push('<hr style=\"margin:4px 0\"/>');
      parts.push(node.methods.map((m) => escapeHtml(m)).join("<br/>"));
    }

    parts.push("</div>");
    const titleHtml = parts.join("");
    lines.push(`  ${node.id}["${titleHtml}"]`);
  }

  if (graph.edges.length === 0 && graph.nodes.length > 1) {
    for (let i = 1; i < graph.nodes.length; i += 1) {
      lines.push(`  ${graph.nodes[0].id} --> ${graph.nodes[i].id}`);
    }
  } else {
    for (const edge of graph.edges) {
      const label = edge.label ? sanitizeMermaidLabel(edge.label) : "";
      lines.push(
        label
          ? `  ${edge.fromId} -->|${label}| ${edge.toId}`
          : `  ${edge.fromId} --> ${edge.toId}`,
      );
    }
  }

  return lines.join("\n");
}

function toEventFlowMermaid(model: unknown): string {
  const root = getObject(model);
  if (!root) {
    return [
      "flowchart LR",
      '  note["No event flow found in server model"]',
    ].join("\n");
  }

  const publishersByEvent = new Map<string, Set<string>>();
  const subscribersByEvent = new Map<string, Set<string>>();
  const participants = new Set<string>();

  const contexts = Array.isArray(root.contexts) ? (root.contexts as unknown[]) : [];
  for (const ctx of contexts) {
    const ctxObj = getObject(ctx);
    if (!ctxObj) continue;

    const flows = Array.isArray(ctxObj.flows) ? (ctxObj.flows as unknown[]) : [];
    for (const f of flows) {
      const fo = getObject(f);
      if (!fo) continue;

      const eventName = readString(fo.eventName) ?? readString(fo.event) ?? undefined;
      const componentName =
        readString(fo.componentName) ?? readString(fo.component) ?? readString(fo.aggregateName) ?? undefined;
      const behaviorName = readString(fo.behaviorName) ?? readString(fo.action) ?? undefined;

      if (!eventName || !componentName) continue;

      const participantLabel = componentName;
      participants.add(participantLabel);

      if (behaviorName) {
        if (!publishersByEvent.has(eventName)) publishersByEvent.set(eventName, new Set());
        publishersByEvent.get(eventName)!.add(participantLabel);
      } else {
        if (!subscribersByEvent.has(eventName)) subscribersByEvent.set(eventName, new Set());
        subscribersByEvent.get(eventName)!.add(participantLabel);
      }
    }

    const eventsArr = Array.isArray(ctxObj.events) ? (ctxObj.events as unknown[]) : [];
    for (const ev of eventsArr) {
      const eo = getObject(ev);
      if (!eo) continue;
      const en = readString(eo.eventName) ?? readString(eo.name) ?? readString(eo.event);
      if (!en) continue;
      if (!publishersByEvent.has(en)) publishersByEvent.set(en, new Set());
    }
  }

  const allEvents = new Set<string>([...publishersByEvent.keys(), ...subscribersByEvent.keys()]);
  if (allEvents.size === 0) {
    return [
      "flowchart LR",
      '  note["No event flow found in server model"]',
    ].join("\n");
  }

  const lines: string[] = ["flowchart LR"];

  // render participant nodes
  for (const p of participants) {
    lines.push(`  ${sanitizeMermaidIdentifier(p)}["${sanitizeMermaidLabel(p)}"]`);
  }

  // per-event no-subscriber sink nodes use unique ids
  for (const eventName of allEvents) {
    const eventId = `E_${sanitizeMermaidIdentifier(eventName)}`;
    const pubs = Array.from(publishersByEvent.get(eventName) ?? []);
    const subs = Array.from(subscribersByEvent.get(eventName) ?? []);

    // define event node (append "(no subscribers)" when applicable)
    const eventLabel = `${sanitizeMermaidLabel(eventName)}${subs.length === 0 ? " (no subscribers)" : ""}`;
    lines.push(`  ${eventId}["${eventLabel}"]`);

    if (pubs.length === 0 && subs.length === 0) {
      continue;
    }

    for (const pub of pubs) {
      if (subs.length === 0) {
        lines.push(`  ${sanitizeMermaidIdentifier(pub)} -->|${sanitizeMermaidLabel(eventName)}| ${eventId}`);
      } else {
        for (const sub of subs) {
          lines.push(`  ${sanitizeMermaidIdentifier(pub)} -->|${sanitizeMermaidLabel(eventName)}| ${sanitizeMermaidIdentifier(sub)}`);
        }
      }
    }
  }

  return lines.join("\n");
}

type GraphNode = {
  id: string;
  label: string;
  type?: string;
  fields?: string[];
  methods?: string[];
};

type GraphEdge = {
  fromId: string;
  toId: string;
  label?: string;
};

function extractGraphModel(model: unknown): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const root = getObject(model);
  if (!root) {
    return { nodes: [], edges: [] };
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeMap = new Map<string, string>();
  const pendingDependencyEdges: Array<{ fromKey: string; toKey: string }> = [];

  const registerNode = (
    keys: Array<string | undefined>,
    label: string,
    type?: string,
    extras?: { fields?: string[]; methods?: string[] },
  ): string => {
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
    nodes.push({ id, label, type, fields: extras?.fields, methods: extras?.methods });
    for (const key of normalizedKeys) {
      nodeMap.set(key, id);
    }
    return id;
  };

  const contextGroup = Array.isArray(root.contexts)
    ? (root.contexts as unknown[])
    : [];
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
      [`context:${contextName}`, contextName],
      contextName,
      "boundedContext",
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
        readString(componentObj.name) ??
        readString(componentObj.label) ??
        componentKey;
      const componentType = readString(componentObj.type) ?? "component";

      const componentId = registerNode(
        [
          `component:${contextName}:${componentKey}`,
          componentKey,
          componentName,
        ],
        componentName,
        componentType,
        undefined,
      );

      edges.push({ fromId: contextId, toId: componentId, label: "contains" });

      if (Array.isArray(componentObj.dependencies)) {
        for (const dependencyCandidate of componentObj.dependencies as unknown[]) {
          if (
            typeof dependencyCandidate === "string" &&
            dependencyCandidate.trim().length > 0
          ) {
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

  // Augment nodes with fields and behaviors when present on components
  for (const contextCandidate of contextGroup) {
    const contextObj = getObject(contextCandidate);
    if (!contextObj) continue;

    const contextName =
      readString(contextObj.boundedContext) ??
      readString(contextObj.name) ??
      readString(contextObj.id);

    const components = Array.isArray(contextObj.components)
      ? (contextObj.components as unknown[])
      : [];

    for (const componentCandidate of components) {
      const componentObj = getObject(componentCandidate);
      if (!componentObj) continue;

      const componentKey =
        readString(componentObj.id) ??
        readString(componentObj.name) ??
        readString(componentObj.key);

      const componentName =
        readString(componentObj.name) ?? readString(componentObj.label) ?? componentKey;

      const lookupKeys = [
        `component:${contextName}:${componentKey}`,
        componentKey,
        componentName,
      ].map((k) => k && k.trim()).filter(Boolean) as string[];

      const nodeId = lookupKeys.map((k) => nodeMap.get(k)).find(Boolean) as string | undefined;
      if (!nodeId) continue;

      const fields: string[] = [];
      const rawFields =
        componentObj.fields ?? componentObj.attributes ?? componentObj.properties ?? componentObj.elements;
      if (Array.isArray(rawFields)) {
        for (const f of rawFields as unknown[]) {
          if (typeof f === "string") {
            fields.push(f);
            continue;
          }
          const fo = getObject(f);
          if (!fo) continue;
          const fname = readString(fo.name) ?? readString(fo.id) ?? readString(fo.key);
          const ftype = readString(fo.type) ?? readString(fo.datatype) ?? readString(fo.label);
          if (fname) {
            fields.push(ftype ? `${fname}: ${ftype}` : fname);
          }
        }
      }

      const methods: string[] = [];
      const rawBehaviors = componentObj.behaviors ?? componentObj.methods ?? componentObj.operations;
      if (Array.isArray(rawBehaviors)) {
        for (const b of rawBehaviors as unknown[]) {
          const bo = getObject(b);
          if (!bo) continue;
          const bname = readString(bo.name) ?? readString(bo.label) ?? readString(bo.phrase);
          if (bname) {
            methods.push(`${bname}()`);
          }
        }
      }

      const idx = nodes.findIndex((n) => n.id === nodeId);
      if (idx >= 0) {
        if (fields.length > 0) nodes[idx].fields = (nodes[idx].fields ?? []).concat(fields);
        if (methods.length > 0) nodes[idx].methods = (nodes[idx].methods ?? []).concat(methods);
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
        readString(objectCandidate.name) ??
        readString(objectCandidate.label) ??
        rawKey;
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

    edges.push({ fromId, toId, label: "depends on" });
  }

  if (nodes.length === 0) {
    const fallbackEntries = Object.entries(root).filter(([, value]) =>
      Array.isArray(value),
    );
    for (const [key, value] of fallbackEntries) {
      if ((value as unknown[]).length === 0) {
        continue;
      }

      const id = `N${nodes.length + 1}`;
      nodes.push({ id, label: key, type: "group" });
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

  const groups = [
    root.flows,
    root.events,
    root.messages,
    root.transitions,
    root.edges,
  ].filter(Array.isArray);
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
        "Domain";
      const to =
        readString(objectCandidate.to) ??
        readString(objectCandidate.target) ??
        readString(objectCandidate.consumer) ??
        "Domain";
      const label =
        readString(objectCandidate.event) ??
        readString(objectCandidate.label) ??
        readString(objectCandidate.name) ??
        "event";

      flows.push({ from, to, label });
    }
  }

  return flows;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function sanitizeMermaidIdentifier(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Node";
  }

  let cleaned = trimmed.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-zA-Z_]/.test(cleaned)) {
    cleaned = `N_${cleaned}`;
  }

  return cleaned;
}

function sanitizeMermaidLabel(value: string): string {
  return value.replace(/"/g, '\\"').replace(/\n/g, " ");
}
