import { useMemo, useState } from "react";

/**
 * 彻底去卡片化的发散式思维导图
 * 节点直接悬浮在聊天背景上，通过动态曲线连接
 */
export function MemoryMindMap({ data }) {
  const [activeNode, setActiveNode] = useState(null);

  const treeData = useMemo(() => {
    try {
      const raw = typeof data === "string" ? JSON.parse(data) : data;
      if (Array.isArray(raw)) {
        return {
          id: 'root',
          name: "记忆核心",
          children: raw.map((item, i) => ({
            id: item.id || `node-${i}`,
            name: item.topic || item.name || "片段",
            content: item.content || item.description || "",
          }))
        };
      }
      if (raw && (raw.topic || raw.content)) {
        return {
          id: raw.id || 'root',
          name: raw.topic || "核心节点",
          content: raw.content || "",
          children: (raw.links || []).map((link, i) => ({
            id: `link-${i}`,
            name: link.targetTopic || "关联",
            content: `关系: ${link.type || "相关"}`,
          }))
        };
      }
      return null;
    } catch (e) { return null; }
  }, [data]);

  if (!treeData) return null;

  // 布局计算：扇形发散
  const children = treeData.children || [];
  const count = children.length;
  const RADIUS = 220; // 发散半径
  const START_X = 50; // 起始点 X
  const START_Y = 150; // 起始点 Y (画布中心)
  
  // 计算每个子节点的位置
  const nodes = children.map((child, i) => {
    // 在 -45度 到 45度 之间均匀分布
    const angle = (count <= 1) ? 0 : ((i / (count - 1)) - 0.5) * Math.PI * 0.6;
    return {
      ...child,
      x: START_X + Math.cos(angle) * RADIUS,
      y: START_Y + Math.sin(angle) * RADIUS
    };
  });

  const svgWidth = 450;
  const svgHeight = 300;

  return (
    <div className="mindmap-ghost-container">
      <svg width={svgWidth} height={svgHeight} viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="mindmap-svg">
        <defs>
          <linearGradient id="edgeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgba(59, 130, 246, 0.6)" />
            <stop offset="100%" stopColor="rgba(59, 130, 246, 0.05)" />
          </linearGradient>
          <filter id="glow">
            <feGaussianBlur stdDeviation="2.5" result="coloredBlur"/>
            <feMerge>
              <feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
        </defs>

        {/* 渲染发散曲线 */}
        {nodes.map((node, i) => (
          <path
            key={`edge-${i}`}
            d={`M ${START_X + 20} ${START_Y} C ${START_X + 120} ${START_Y}, ${node.x - 80} ${node.y}, ${node.x} ${node.y}`}
            className="mindmap-ghost-edge"
          />
        ))}

        {/* 中心核心点 */}
        <g transform={`translate(${START_X}, ${START_Y})`} className="mindmap-center">
          <circle r="8" fill="#3b82f6" filter="url(#glow)" />
          <circle r="12" fill="none" stroke="#3b82f6" strokeWidth="1" strokeDasharray="2 2" className="rotating-ring" />
          <text x="15" y="5" className="mindmap-root-text">{treeData.name}</text>
        </g>

        {/* 发散节点 */}
        {nodes.map((node, i) => (
          <g 
            key={node.id} 
            transform={`translate(${node.x}, ${node.y})`}
            className={`mindmap-ghost-node ${activeNode === node.id ? 'active' : ''}`}
            onClick={() => setActiveNode(activeNode === node.id ? null : node.id)}
          >
            <circle r="5" className="node-dot" />
            <rect x="10" y="-12" width="100" height="24" rx="12" className="node-label-bg" />
            <text x="20" y="4" className="node-label-text">
              {node.name.length > 8 ? node.name.slice(0, 8) + "..." : node.name}
            </text>
          </g>
        ))}
      </svg>

      {/* 悬浮详情窗 */}
      {activeNode && (
        <div className="mindmap-ghost-popover" style={{ 
          left: nodes.find(n => n.id === activeNode)?.x + 20,
          top: nodes.find(n => n.id === activeNode)?.y - 40 
        }}>
          <div className="popover-content">
            {nodes.find(n => n.id === activeNode)?.content}
          </div>
          <div className="popover-arrow" />
        </div>
      )}
    </div>
  );
}
