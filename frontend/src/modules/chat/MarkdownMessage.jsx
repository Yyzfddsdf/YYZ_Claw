import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

function normalizeMathDelimiters(input) {
  const source = String(input ?? "");
  const fencedBlockPattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;

  return source
    .split(fencedBlockPattern)
    .map((segment) => {
      if (segment.startsWith("```") || segment.startsWith("~~~")) {
        return segment;
      }

      return segment
        .replace(/\\\[([\s\S]*?)\\\]/g, (_, expression) => {
          const trimmed = String(expression ?? "").trim();
          return trimmed ? `$$\n${trimmed}\n$$` : "";
        })
        .replace(/\\\(([\s\S]*?)\\\)/g, (_, expression) => {
          const trimmed = String(expression ?? "").trim();
          return trimmed ? `$${trimmed}$` : "";
        });
    })
    .join("");
}

function createHeading(level) {
  const Tag = `h${level}`;
  return function MarkdownHeading({ children, ...props }) {
    return (
      <Tag {...props} className={`markdown-heading level-${level}`}>
        {children}
      </Tag>
    );
  };
}

function getAlignmentClass(node) {
  const align = String(node?.properties?.align ?? "").trim().toLowerCase();
  if (align === "center" || align === "right") {
    return `markdown-table-cell is-${align}`;
  }
  return "markdown-table-cell is-left";
}

const markdownComponents = {
  h1: createHeading(1),
  h2: createHeading(2),
  h3: createHeading(3),
  h4: createHeading(4),
  h5: createHeading(5),
  h6: createHeading(6),
  p({ children, ...props }) {
    return (
      <p {...props} className="markdown-paragraph">
        {children}
      </p>
    );
  },
  ul({ children, ...props }) {
    return (
      <ul {...props} className="markdown-list">
        {children}
      </ul>
    );
  },
  ol({ children, ...props }) {
    return (
      <ol {...props} className="markdown-list">
        {children}
      </ol>
    );
  },
  blockquote({ children, ...props }) {
    return (
      <blockquote {...props} className="markdown-quote">
        {children}
      </blockquote>
    );
  },
  hr(props) {
    return <hr {...props} className="markdown-hr" />;
  },
  table({ children, ...props }) {
    return (
      <div className="markdown-table-wrap">
        <table {...props} className="markdown-table">
          {children}
        </table>
      </div>
    );
  },
  th({ children, node, ...props }) {
    return (
      <th {...props} className={getAlignmentClass(node)}>
        {children}
      </th>
    );
  },
  td({ children, node, ...props }) {
    return (
      <td {...props} className={getAlignmentClass(node)}>
        {children}
      </td>
    );
  },
  pre({ children, ...props }) {
    return (
      <pre {...props} className="markdown-code-block">
        {children}
      </pre>
    );
  },
  code({ children, className = "", ...props }) {
    return (
      <code {...props} className={className}>
        {children}
      </code>
    );
  },
  a({ children, href = "", ...props }) {
    return (
      <a {...props} href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
  img({ alt = "", ...props }) {
    return <img {...props} alt={alt} className="markdown-image" loading="lazy" />;
  }
};

function MarkdownMessageComponent({ content, className = "" }) {
  const source = String(content ?? "");
  const processedContent = useMemo(() => normalizeMathDelimiters(source), [source]);

  if (!source.trim()) {
    return <p className={`markdown markdown-empty ${className}`.trim()}>...</p>;
  }

  return (
    <ReactMarkdown
      className={`markdown ${className}`.trim()}
      components={markdownComponents}
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      skipHtml
    >
      {processedContent}
    </ReactMarkdown>
  );
}

export const MarkdownMessage = memo(
  MarkdownMessageComponent,
  (prev, next) => prev.content === next.content && prev.className === next.className
);
