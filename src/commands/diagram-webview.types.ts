export type DiagramKind = "component" | "eventFlow";

export type DiagramPayload = {
  mermaid: string;
  sourceUri: string;
  generatedAt: string;
};

export type DiagramViewState = {
  activeTab: DiagramKind;
  component?: DiagramPayload;
  eventFlow?: DiagramPayload;
};
