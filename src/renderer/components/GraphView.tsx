import { useState } from "react";
import type { NoteGraph } from "../../shared/ipc";

interface GraphViewProps {
  graph: NoteGraph;
  focusedNoteId: string | null;
  onOpenNote: (id: string) => void;
}

export function GraphView({ graph, focusedNoteId, onOpenNote }: GraphViewProps) {
  const [localOnly, setLocalOnly] = useState(false);
  const visibleGraph = (() => {
    if (!localOnly || !focusedNoteId) return graph;
    const linkedIds = new Set(
      graph.edges
        .filter((edge) => edge.sourceId === focusedNoteId || edge.targetId === focusedNoteId)
        .flatMap((edge) => [edge.sourceId, edge.targetId]),
    );
    linkedIds.add(focusedNoteId);
    return {
      nodes: graph.nodes.filter((node) => linkedIds.has(node.id)),
      edges: graph.edges.filter(
        (edge) => linkedIds.has(edge.sourceId) && linkedIds.has(edge.targetId),
      ),
      unlinkedMentions: [],
    };
  })();
  const width = 1000;
  const height = 700;
  const radius = Math.min(width, height) * 0.38;
  const positioned = visibleGraph.nodes.map((note, index) => {
    const angle = (2 * Math.PI * index) / Math.max(visibleGraph.nodes.length, 1) - Math.PI / 2;
    return {
      ...note,
      x: width / 2 + Math.cos(angle) * (graph.nodes.length === 1 ? 0 : radius),
      y: height / 2 + Math.sin(angle) * (graph.nodes.length === 1 ? 0 : radius),
    };
  });
  const positions = new Map(positioned.map((node) => [node.id, node]));

  return (
    <section className="graph-view" aria-label="Note graph">
      <header className="graph-view__header">
        <div>
          <h1>Note graph</h1>
          <p>
            {visibleGraph.nodes.length} {visibleGraph.nodes.length === 1 ? "note" : "notes"} ·{" "}
            {visibleGraph.edges.length} {visibleGraph.edges.length === 1 ? "link" : "links"}
          </p>
        </div>
        <div className="graph-view__scope" role="group" aria-label="Graph scope">
          <button
            type="button"
            aria-pressed={!localOnly}
            onClick={() => setLocalOnly(false)}
          >
            All notes
          </button>
          <button
            type="button"
            disabled={!focusedNoteId}
            aria-pressed={localOnly}
            onClick={() => setLocalOnly(true)}
          >
            Current note
          </button>
        </div>
      </header>
      {visibleGraph.nodes.length === 0 ? (
        <p className="graph-view__empty">Create a note and link it with [[Note title]].</p>
      ) : (
        <svg
          className="graph-view__canvas"
          viewBox={`0 0 ${width} ${height}`}
          role="group"
          aria-label="Graph of linked notes"
        >
          {visibleGraph.edges.map((edge) => {
            const source = positions.get(edge.sourceId);
            const target = positions.get(edge.targetId);
            if (!source || !target) return null;
            return (
              <line
                key={`${edge.sourceId}:${edge.targetId}`}
                className="graph-view__edge"
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
              />
            );
          })}
          {positioned.map((node) => (
            <g
              key={node.id}
              className="graph-view__node"
              transform={`translate(${node.x}, ${node.y})`}
              role="button"
              tabIndex={0}
              aria-label={`Open ${node.title || "Untitled"}`}
              onClick={() => onOpenNote(node.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpenNote(node.id);
                }
              }}
            >
              <title>{`${node.title || "Untitled"}${node.folderPath ? ` — ${node.folderPath}` : ""}`}</title>
              <circle r="9" />
              <text y="25" textAnchor="middle">
                {(node.title || "Untitled").slice(0, 24)}
                {(node.title || "Untitled").length > 24 ? "…" : ""}
              </text>
            </g>
          ))}
        </svg>
      )}
    </section>
  );
}
