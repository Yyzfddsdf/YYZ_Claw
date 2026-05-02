import { createMathPlugin } from "@streamdown/math";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";

const streamdownMathPlugin = createMathPlugin({
  errorColor: "currentColor",
  singleDollarTextMath: true
});

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

function getAlignmentClass(style = {}) {
  const textAlign = String(style?.textAlign ?? "").trim().toLowerCase();
  if (textAlign === "center" || textAlign === "right") {
    return `markdown-table-cell is-${textAlign}`;
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
  th({ children, style, ...props }) {
    return (
      <th {...props} style={style} className={getAlignmentClass(style)}>
        {children}
      </th>
    );
  },
  td({ children, style, ...props }) {
    return (
      <td {...props} style={style} className={getAlignmentClass(style)}>
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
  inlineCode({ children, ...props }) {
    return <code {...props}>{children}</code>;
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

function useThrottledStreamingContent(content, streaming) {
  const source = String(content ?? "");
  const latestRef = useRef(source);
  const timerRef = useRef(null);
  const [visibleContent, setVisibleContent] = useState(source);

  useEffect(() => {
    latestRef.current = source;

    if (!streaming) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setVisibleContent(source);
      return undefined;
    }

    if (timerRef.current) {
      return undefined;
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setVisibleContent(latestRef.current);
    }, 90);

    return undefined;
  }, [source, streaming]);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    []
  );

  return streaming ? visibleContent : source;
}

function MarkdownMessageComponent({ content, className = "", streaming = false }) {
  const renderContent = useThrottledStreamingContent(content, streaming);
  const processedContent = useMemo(() => normalizeMathDelimiters(renderContent), [renderContent]);

  if (!String(content ?? "").trim()) {
    return <p className={`markdown markdown-empty ${className}`.trim()}>...</p>;
  }

  return (
    <Streamdown
      animated={false}
      className={`markdown ${className}`.trim()}
      components={markdownComponents}
      controls={false}
      mode={streaming ? "streaming" : "static"}
      normalizeHtmlIndentation
      parseIncompleteMarkdown={streaming}
      plugins={{ math: streamdownMathPlugin }}
      skipHtml
    >
      {processedContent}
    </Streamdown>
  );
}

export const MarkdownMessage = memo(
  MarkdownMessageComponent,
  (prev, next) =>
    prev.content === next.content &&
    prev.className === next.className &&
    prev.streaming === next.streaming
);
