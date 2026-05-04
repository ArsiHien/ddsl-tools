import * as vscode from "vscode";
import { buildDiagramWebviewHtml } from "./diagram-webview.html";
import type { DiagramKind, DiagramPayload } from "./diagram-webview.types";

export type { DiagramKind, DiagramPayload } from "./diagram-webview.types";

export class DiagramPanel {
  private componentDiagram: DiagramPayload | undefined;
  private eventFlowDiagram: DiagramPayload | undefined;
  private activeTab: DiagramKind = "component";

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
    onDispose: () => void,
  ) {
    this.panel.onDidDispose(onDispose);
  }

  public static create(
    context: vscode.ExtensionContext,
    onDispose: () => void,
  ): DiagramPanel {
    const panel = vscode.window.createWebviewPanel(
      "ddslDiagrams",
      "DDSL Diagrams",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(
            context.extensionUri,
            "node_modules",
            "mermaid",
            "dist",
          ),
          context.extensionUri,
        ],
      },
    );

    return new DiagramPanel(context, panel, onDispose);
  }

  public show(
    kind: DiagramKind,
    payload: DiagramPayload,
    options?: { activateTab?: boolean },
  ): void {
    if (kind === "component") {
      this.componentDiagram = payload;
    } else {
      this.eventFlowDiagram = payload;
    }

    if (options?.activateTab !== false) {
      this.activeTab = kind;
    }

    this.panel.title =
      this.activeTab === "component"
        ? "DDSL Component Diagram"
        : "DDSL Event Flow Diagram";
    this.panel.webview.html = this.renderHtml(this.activeTab);
    this.panel.reveal(vscode.ViewColumn.Beside, false);
  }

  private renderHtml(activeTab: DiagramKind): string {
    const webview = this.panel.webview;
    const nonce = createNonce();
    const mermaidScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "node_modules",
        "mermaid",
        "dist",
        "mermaid.min.js",
      ),
    );

    return buildDiagramWebviewHtml({
      nonce,
      mermaidScriptUri: mermaidScriptUri.toString(),
      cspSource: webview.cspSource,
      state: {
        activeTab,
        component: this.componentDiagram,
        eventFlow: this.eventFlowDiagram,
      },
    });
  }
}

function createNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
