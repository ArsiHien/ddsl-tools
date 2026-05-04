import { DIAGRAM_WEBVIEW_CSS } from "./diagram-webview.styles";
import type { DiagramViewState } from "./diagram-webview.types";

type BuildDiagramWebviewHtmlOptions = {
  nonce: string;
  mermaidScriptUri: string;
  state: DiagramViewState;
  cspSource: string;
};

export function buildDiagramWebviewHtml(
  options: BuildDiagramWebviewHtmlOptions,
): string {
  const csp = [
    `default-src 'none'`,
    `img-src ${options.cspSource} data:`,
    `style-src ${options.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${options.nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DDSL Diagrams</title>
  <style>${DIAGRAM_WEBVIEW_CSS}</style>
</head>
<body>
  <div class="app">
    <div class="header">
      <h1 class="title">DDSL Diagram Studio</h1>
      <div id="meta" class="meta"></div>
    </div>
    
    <div class="content">
      <div id="status" class="empty status"></div>
      <div id="diagram" class="diagram-wrap"></div>
      <div id="mermaid-source" class="mermaid-source" hidden></div>
    </div>
  </div>

  <script nonce="${options.nonce}" src="${options.mermaidScriptUri}"></script>
  <script nonce="${options.nonce}">
    console.log('[DiagramView] Initializing webview');
    const state = ${JSON.stringify(options.state)};
    let activeTab = state.activeTab || 'component';

    console.log('[DiagramView] State:', state);
    console.log('[DiagramView] Active tab:', activeTab);

    const tabComponent = document.getElementById('tab-component');
    const tabEventFlow = document.getElementById('tab-eventFlow');
    const diagramEl = document.getElementById('diagram');
    const sourceEl = document.getElementById('mermaid-source');
    const metaEl = document.getElementById('meta');
    const statusEl = document.getElementById('status');

    console.log('[DiagramView] DOM elements found:', {
      tabComponent: !!tabComponent,
      tabEventFlow: !!tabEventFlow,
      diagramEl: !!diagramEl,
      sourceEl: !!sourceEl,
      metaEl: !!metaEl,
      statusEl: !!statusEl,
    });

    const diagramMap = {
      component: state.component,
      eventFlow: state.eventFlow,
    };

    console.log('[DiagramView] Diagram map:', diagramMap);

    if (tabComponent) {
      tabComponent.addEventListener('click', () => {
        activeTab = 'component';
        render();
      });
    }

    if (tabEventFlow) {
      tabEventFlow.addEventListener('click', () => {
        activeTab = 'eventFlow';
        render();
      });
    }

    function escapeHtml(value) {
      return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    async function render() {
      console.log('[DiagramView] Render called, activeTab:', activeTab);
      if (tabComponent) tabComponent.classList.toggle('active', activeTab === 'component');
      if (tabEventFlow) tabEventFlow.classList.toggle('active', activeTab === 'eventFlow');

      const current = diagramMap[activeTab];
      console.log('[DiagramView] Current diagram:', current);
      if (!current || !current.mermaid) {
        console.log('[DiagramView] No diagram content');
        statusEl.style.display = 'block';
        statusEl.textContent = 'No Mermaid content available for this diagram.';
        diagramEl.innerHTML = '<div class="empty">Run the selected diagram command to generate and render Mermaid content.</div>';
        sourceEl.hidden = true;
        metaEl.textContent = 'No diagram available yet.';
        return;
      }

      const generatedAt = new Date(current.generatedAt).toLocaleString();
      metaEl.textContent = 'Source: ' + current.sourceUri + ' | Generated: ' + generatedAt;
      statusEl.style.display = 'none';

      diagramEl.innerHTML = '<div class="mermaid-loading">Rendering diagram...</div>';
      sourceEl.textContent = current.mermaid;
      sourceEl.hidden = false;

      try {
        console.log('[DiagramView] Initializing mermaid');
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'loose',
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

        const diagramId = 'diagram-' + activeTab + '-' + Date.now();
        console.log('[DiagramView] Rendering mermaid with ID:', diagramId);
        const rendered = await mermaid.render(diagramId, current.mermaid);
        console.log('[DiagramView] Mermaid render result:', rendered);
        if (!rendered || !rendered.svg || !rendered.svg.trim()) {
          throw new Error('Mermaid returned an empty diagram.');
        }

        console.log('[DiagramView] Setting SVG to diagram element');
        diagramEl.innerHTML = rendered.svg;
        if (typeof rendered.bindFunctions === 'function') {
          rendered.bindFunctions(diagramEl);
        }
        console.log('[DiagramView] Render complete');
      } catch (error) {
        console.error('[DiagramView] Render error:', error);
        const message = error && error.message ? error.message : String(error);
        statusEl.style.display = 'block';
        statusEl.textContent = 'Mermaid render failed: ' + message;
        diagramEl.innerHTML = '<pre class="mermaid-source" style="margin-top:0; white-space: pre-wrap;">' + escapeHtml(current.mermaid) + '</pre>';
      }
    }

    console.log('[DiagramView] Calling initial render');
    render();
    console.log('[DiagramView] Setup complete');
  </script>
</body>
</html>`;
}
