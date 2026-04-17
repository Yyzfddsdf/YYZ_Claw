import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hierarchy, tree } from "d3-hierarchy";
import { select } from "d3-selection";
import { linkHorizontal } from "d3-shape";
import { zoom, zoomIdentity } from "d3-zoom";

function getNodeVisual(type) {
  switch (type) {
    case "topic":
      return { radius: 13, labelWidth: 176, className: "topic" };
    case "content":
      return { radius: 11, labelWidth: 194, className: "content" };
    case "node":
      return { radius: 9, labelWidth: 210, className: "node" };
    case "loading":
      return { radius: 7, labelWidth: 156, className: "loading" };
    default:
      return { radius: 15, labelWidth: 164, className: "root" };
  }
}

function createLayout(treeData) {
  const root = hierarchy(treeData, (datum) => (Array.isArray(datum.children) ? datum.children : []));
  const layout = tree()
    .nodeSize([106, 250])
    .separation((left, right) => (left.parent === right.parent ? 1 : 1.15));
  const positioned = layout(root);
  const nodes = positioned.descendants();
  const links = positioned.links();

  const bounds = nodes.reduce(
    (accumulator, node) => ({
      minX: Math.min(accumulator.minX, node.x),
      maxX: Math.max(accumulator.maxX, node.x),
      minY: Math.min(accumulator.minY, node.y),
      maxY: Math.max(accumulator.maxY, node.y)
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
  );

  return {
    nodes,
    links,
    bounds
  };
}

export function MemoryMap({
  treeData,
  selectedKey,
  loading,
  fitToken,
  onNodeActivate,
  onBackgroundSelect
}) {
  const containerRef = useRef(null);
  const svgRef = useRef(null);
  const viewportRef = useRef(null);
  const zoomBehaviorRef = useRef(null);
  const layoutBoundsRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!containerRef.current || typeof ResizeObserver !== "function") {
      return undefined;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      setSize({
        width: Math.max(0, Math.floor(entry.contentRect.width)),
        height: Math.max(0, Math.floor(entry.contentRect.height))
      });
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const { nodes, links, bounds } = useMemo(() => createLayout(treeData), [treeData]);

  layoutBoundsRef.current = bounds;

  const pathGenerator = useMemo(
    () =>
      linkHorizontal()
        .x((point) => point.y)
        .y((point) => point.x),
    []
  );

  const fitTreeToViewport = useCallback(() => {
    if (!svgRef.current || !zoomBehaviorRef.current || !layoutBoundsRef.current) {
      return;
    }

    const width = Number(size.width ?? 0);
    const height = Number(size.height ?? 0);
    if (width <= 0 || height <= 0) {
      return;
    }

    const boundsValue = layoutBoundsRef.current;
    const paddingX = 180;
    const paddingY = 120;
    const treeWidth = Math.max(1, boundsValue.maxY - boundsValue.minY + paddingX * 2);
    const treeHeight = Math.max(1, boundsValue.maxX - boundsValue.minX + paddingY * 2);
    const scale = Math.min(1.08, Math.max(0.52, Math.min(width / treeWidth, height / treeHeight)));
    const centerX = (boundsValue.minY + boundsValue.maxY) / 2;
    const centerY = (boundsValue.minX + boundsValue.maxX) / 2;
    const nextTransform = zoomIdentity
      .translate(width / 2 - centerX * scale, height / 2 - centerY * scale)
      .scale(scale);

    select(svgRef.current).call(zoomBehaviorRef.current.transform, nextTransform);
  }, [size.height, size.width]);

  useEffect(() => {
    if (!svgRef.current || !viewportRef.current) {
      return undefined;
    }

    const svgSelection = select(svgRef.current);
    const nextZoom = zoom()
      .scaleExtent([0.45, 1.85])
      .on("zoom", (event) => {
        select(viewportRef.current).attr("transform", event.transform);
      });

    zoomBehaviorRef.current = nextZoom;
    svgSelection.call(nextZoom);
    svgSelection.on("dblclick.zoom", null);

    return () => {
      svgSelection.on(".zoom", null);
      zoomBehaviorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      fitTreeToViewport();
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [bounds.maxX, bounds.maxY, bounds.minX, bounds.minY, fitTreeToViewport, fitToken, nodes.length]);

  return (
    <div ref={containerRef} className="memory-map-shell">
      <svg
        ref={svgRef}
        className="memory-map-svg"
        width={size.width || 0}
        height={size.height || 0}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest(".memory-map-node")) {
            return;
          }
          onBackgroundSelect();
        }}
      >
        <defs>
          <filter id="memoryNodeGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="4" result="glow" />
            <feMerge>
              <feMergeNode in="glow" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient id="memoryLinkGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgba(99, 102, 241, 0.28)" />
            <stop offset="100%" stopColor="rgba(14, 165, 233, 0.16)" />
          </linearGradient>
        </defs>

        <g ref={viewportRef}>
          {links.map((link, index) => (
            <path
              key={`${link.source.data.key}-${link.target.data.key}`}
              d={pathGenerator(link)}
              className={`memory-map-link memory-map-link-${link.target.data.type || "generic"}`}
              style={{ animationDelay: `${Math.min(index * 16, 220)}ms` }}
            />
          ))}

          {nodes.map((node, index) => {
            const datum = node.data;
            const visual = getNodeVisual(datum.type);
            const labelWidth = visual.labelWidth;
            const labelHeight = datum.type === "root" ? 58 : datum.subtitle ? 60 : 44;
            const isSelected = selectedKey === datum.key;
            const isInteractive = !datum.isPlaceholder;

            return (
              <g
                key={datum.key}
                className={`memory-map-node memory-map-node-${visual.className} ${
                  isSelected ? "is-selected" : ""
                } ${isInteractive ? "is-interactive" : "is-placeholder"}`}
                transform={`translate(${node.y}, ${node.x})`}
                style={{ animationDelay: `${Math.min(index * 20, 260)}ms` }}
                filter={isSelected ? "url(#memoryNodeGlow)" : undefined}
                role={isInteractive ? "button" : undefined}
                tabIndex={isInteractive ? 0 : undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  if (isInteractive) {
                    onNodeActivate(datum);
                  }
                }}
                onKeyDown={(event) => {
                  if (!isInteractive) {
                    return;
                  }
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onNodeActivate(datum);
                  }
                }}
              >
                <circle className="memory-map-node-core" r={visual.radius} />
                <circle className="memory-map-node-ring" r={visual.radius + 6} />

                <g transform={`translate(${visual.radius + 14}, ${-labelHeight / 2})`}>
                  <rect
                    className="memory-map-node-card"
                    width={labelWidth}
                    height={labelHeight}
                    rx="16"
                    ry="16"
                  />
                  <text className="memory-map-node-title" x="18" y="22">
                    {datum.label}
                  </text>
                  {datum.subtitle ? (
                    <text className="memory-map-node-subtitle" x="18" y={labelHeight - 16}>
                      {datum.subtitle}
                    </text>
                  ) : null}
                  {datum.meta ? (
                    <text className="memory-map-node-meta" x={labelWidth - 18} y="22">
                      {datum.meta}
                    </text>
                  ) : null}
                </g>
              </g>
            );
          })}
        </g>
      </svg>

      <div className="memory-map-overlay">
        <div className="memory-map-overlay-card">
          <strong>长期记忆图谱</strong>
          <span>
            点击主题展开内容块，点击内容块再展开记忆节点。滚轮缩放，拖动画布平移。
          </span>
        </div>
        {loading && <div className="memory-map-loading-pill">正在同步记忆数据…</div>}
      </div>
    </div>
  );
}
