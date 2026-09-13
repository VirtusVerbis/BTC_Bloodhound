import { BaseEdge, getBezierPath, Position, type EdgeProps } from "@xyflow/react";
import { REFUND_EDGE_COLOR } from "../../lib/graphEdgeRender";

export function RefundEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  label,
  markerEnd,
  style,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition: Position.Top,
    targetPosition: Position.Top,
    curvature: 0.35,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: REFUND_EDGE_COLOR,
          strokeWidth: 2,
          strokeDasharray: "6 4",
          fill: "none",
          ...style,
        }}
      />
      {label ? (
        <text
          x={labelX}
          y={labelY - 8}
          textAnchor="middle"
          className="refund-edge-label"
          fill={REFUND_EDGE_COLOR}
          fontSize={11}
          pointerEvents="none"
        >
          {label}
        </text>
      ) : null}
    </>
  );
}
