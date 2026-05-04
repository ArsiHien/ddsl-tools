export const DIAGRAM_WEBVIEW_CSS = String.raw`
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
  flex-direction: column;
  align-items: stretch;
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

.diagram-wrap svg {
  max-width: 100%;
  height: auto;
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

.mermaid-loading {
  color: var(--muted);
  padding: 20px;
}

.status {
  display: none;
  margin-bottom: 12px;
}

@media (max-width: 860px) {
  body { padding: 10px; }
  .app { min-height: calc(100vh - 20px); }
  .tabs { flex-wrap: wrap; }
  .tab { flex: 1 1 220px; }
}
`;
