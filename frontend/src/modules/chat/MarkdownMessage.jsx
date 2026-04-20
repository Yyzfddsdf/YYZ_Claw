import katex from "katex";
import "katex/dist/katex.min.css";
import { memo, useMemo } from "react";

const GREEK_LATEX_MAP = new Map([
  ["alpha", "\\alpha"],
  ["beta", "\\beta"],
  ["gamma", "\\gamma"],
  ["delta", "\\delta"],
  ["epsilon", "\\epsilon"],
  ["varepsilon", "\\varepsilon"],
  ["zeta", "\\zeta"],
  ["eta", "\\eta"],
  ["theta", "\\theta"],
  ["vartheta", "\\vartheta"],
  ["iota", "\\iota"],
  ["kappa", "\\kappa"],
  ["lambda", "\\lambda"],
  ["mu", "\\mu"],
  ["nu", "\\nu"],
  ["xi", "\\xi"],
  ["pi", "\\pi"],
  ["varpi", "\\varpi"],
  ["rho", "\\rho"],
  ["varrho", "\\varrho"],
  ["sigma", "\\sigma"],
  ["varsigma", "\\varsigma"],
  ["tau", "\\tau"],
  ["phi", "\\phi"],
  ["varphi", "\\varphi"],
  ["chi", "\\chi"],
  ["psi", "\\psi"],
  ["omega", "\\omega"],
  ["Gamma", "\\Gamma"],
  ["Delta", "\\Delta"],
  ["Theta", "\\Theta"],
  ["Lambda", "\\Lambda"],
  ["Xi", "\\Xi"],
  ["Pi", "\\Pi"],
  ["Sigma", "\\Sigma"],
  ["Upsilon", "\\Upsilon"],
  ["Phi", "\\Phi"],
  ["Psi", "\\Psi"],
  ["Omega", "\\Omega"]
]);

const MATH_COMMAND_MAP = new Map([
  ["frac", "\\frac"],
  ["sqrt", "\\sqrt"],
  ["cdot", "\\cdot"],
  ["times", "\\times"],
  ["pm", "\\pm"],
  ["mp", "\\mp"],
  ["leq", "\\leq"],
  ["geq", "\\geq"],
  ["neq", "\\neq"],
  ["left", "\\left"],
  ["right", "\\right"],
  ["begin", "\\begin"],
  ["end", "\\end"],
  ["text", "\\text"],
  ["mathrm", "\\mathrm"],
  ["operatorname", "\\operatorname"],
  ["sum", "\\sum"],
  ["int", "\\int"],
  ["prod", "\\prod"],
  ["coprod", "\\coprod"],
  ["oint", "\\oint"],
  ["partial", "\\partial"],
  ["infty", "\\infty"],
  ["nabla", "\\nabla"],
  ["rightarrow", "\\rightarrow"],
  ["leftarrow", "\\leftarrow"],
  ["Rightarrow", "\\Rightarrow"],
  ["Leftarrow", "\\Leftarrow"],
  ["leftrightarrow", "\\leftrightarrow"],
  ["Leftrightarrow", "\\Leftrightarrow"],
  ["approx", "\\approx"],
  ["propto", "\\propto"],
  ["equiv", "\\equiv"],
  ["forall", "\\forall"],
  ["exists", "\\exists"],
  ["in", "\\in"],
  ["notin", "\\notin"],
  ["subset", "\\subset"],
  ["supset", "\\supset"],
  ["subseteq", "\\subseteq"],
  ["supseteq", "\\supseteq"],
  ["cup", "\\cup"],
  ["cap", "\\cap"],
  ["setminus", "\\setminus"],
  ["emptyset", "\\emptyset"],
  ["varnothing", "\\varnothing"],
  ["oplus", "\\oplus"],
  ["otimes", "\\otimes"],
  ["dots", "\\dots"],
  ["cdots", "\\cdots"],
  ["vdots", "\\vdots"],
  ["ddots", "\\ddots"],
  ["vec", "\\vec"],
  ["hat", "\\hat"],
  ["bar", "\\bar"],
  ["tilde", "\\tilde"],
  ["binom", "\\binom"],
  ["choose", "\\choose"]
]);

const MATH_OPERATOR_MAP = new Map([
  ["cov", "\\operatorname{Cov}"],
  ["var", "\\operatorname{Var}"],
  ["poisson", "\\operatorname{Poisson}"],
  ["exp", "\\exp"],
  ["log", "\\log"],
  ["ln", "\\ln"],
  ["sin", "\\sin"],
  ["cos", "\\cos"],
  ["tan", "\\tan"],
  ["sec", "\\sec"],
  ["csc", "\\csc"],
  ["cot", "\\cot"],
  ["arcsin", "\\arcsin"],
  ["arccos", "\\arccos"],
  ["arctan", "\\arctan"],
  ["sinh", "\\sinh"],
  ["cosh", "\\cosh"],
  ["tanh", "\\tanh"],
  ["min", "\\min"],
  ["max", "\\max"],
  ["inf", "\\inf"],
  ["sup", "\\sup"],
  ["lim", "\\lim"],
  ["liminf", "\\liminf"],
  ["limsup", "\\limsup"],
  ["argmin", "\\operatorname{argmin}"],
  ["argmax", "\\operatorname{argmax}"],
  ["det", "\\det"],
  ["dim", "\\dim"],
  ["ker", "\\ker"],
  ["hom", "\\hom"],
  ["deg", "\\deg"],
  ["arg", "\\arg"],
  ["pr", "\\mathbb{P}"]
]);

const MATH_ENV_KEYS = [
  "matrix",
  "pmatrix",
  "bmatrix",
  "vmatrix",
  "Bmatrix",
  "Vmatrix",
  "smallmatrix",
  "cases",
  "rcases",
  "dcases",
  "drcases",
  "aligned",
  "alignedat",
  "align",
  "alignat",
  "equation",
  "gather",
  "gathered",
  "eqnarray",
  "multline",
  "array"
];

const MATH_OPERATOR_TOKEN_KEYS = [
  ...Array.from(MATH_OPERATOR_MAP.keys()).map(k => k.toLowerCase()),
  ...Array.from(GREEK_LATEX_MAP.keys()).map(k => k.toLowerCase()),
  ...MATH_ENV_KEYS.map(k => k.toLowerCase()),
  "e",
  "p"
].sort((a, b) => b.length - a.length);

const ESCAPED_COMMAND_KEYS = [
  ...Array.from(MATH_COMMAND_MAP.keys()).map(k => k.toLowerCase()),
  ...Array.from(MATH_OPERATOR_MAP.keys()).map(k => k.toLowerCase()),
  ...Array.from(GREEK_LATEX_MAP.keys()).map(k => k.toLowerCase())
].sort((a, b) => b.length - a.length);

const GREEK_SEQUENCE_KEYS = [...new Set(
  Array.from(GREEK_LATEX_MAP.keys())
    .map((k) => k.toLowerCase())
    .filter((k) => k.length >= 2)
)].sort((a, b) => b.length - a.length);

function isCjkCharacter(char) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(char);
}

function splitConcatenatedGreekWord(word) {
  const source = String(word ?? "");

  if (!/^[A-Za-z]+$/.test(source)) {
    return null;
  }

  const lowered = source.toLowerCase();
  const tokens = [];
  let index = 0;

  while (index < source.length) {
    let matched = "";

    for (const candidate of GREEK_SEQUENCE_KEYS) {
      if (lowered.startsWith(candidate, index)) {
        matched = source.slice(index, index + candidate.length);
        break;
      }
    }

    if (!matched) {
      return null;
    }

    tokens.push(matched);
    index += matched.length;
  }

  return tokens.length >= 2 ? tokens : null;
}

function splitMathTokenWord(word) {
  const source = String(word ?? "");
  const lowered = source.toLowerCase();

  // If the word as a whole is a recognized command, don't chop it (preserves bare 'sum', 'frac', etc.)
  if (MATH_COMMAND_MAP.has(lowered) || MATH_OPERATOR_MAP.has(lowered) || GREEK_LATEX_MAP.has(lowered)) {
    return [source];
  }

  if (/^[A-Za-z]+$/.test(source)) {
    const greekParts = splitConcatenatedGreekWord(source);
    if (greekParts) {
      return greekParts;
    }

    return [source];
  }

  const tokens = [];
  let index = 0;

  while (index < source.length) {
    let matched = "";

    for (const candidate of MATH_OPERATOR_TOKEN_KEYS) {
      if (source.slice(index).toLowerCase().startsWith(candidate)) {
        matched = source.slice(index, index + candidate.length);
        break;
      }
    }

    if (matched) {
      tokens.push(matched);
      index += matched.length;
      continue;
    }

    tokens.push(source[index]);
    index += 1;
  }

  return tokens;
}

function normalizeMathToken(token) {
  const source = String(token ?? "");

  if (!source) {
    return "";
  }

  if (source.startsWith("\\")) {
    const commandSource = source.slice(1);

    // Try exact case match first (important for Greek letters like \Gamma vs \gamma)
    let matchedKey = ESCAPED_COMMAND_KEYS.find((key) =>
      commandSource.startsWith(key)
    );

    // If no exact match, try case-insensitive
    if (!matchedKey) {
      matchedKey = ESCAPED_COMMAND_KEYS.find((key) =>
        commandSource.toLowerCase().startsWith(key.toLowerCase())
      );
    }

    if (matchedKey) {
      const matchedKeyLower = matchedKey.toLowerCase();
      const greekKey = Array.from(GREEK_LATEX_MAP.keys()).find(
        (k) => k.toLowerCase() === matchedKeyLower
      );
      const commandKey = Array.from(MATH_COMMAND_MAP.keys()).find(
        (k) => k.toLowerCase() === matchedKeyLower
      );
      const operatorKey = Array.from(MATH_OPERATOR_MAP.keys()).find(
        (k) => k.toLowerCase() === matchedKeyLower
      );
      const remainder = commandSource.slice(matchedKey.length);

      // Operator aliases like \var, \cov, \pr are not native KaTeX commands.
      if (operatorKey && !greekKey) {
        // Keep unknown longer commands intact, e.g. \varnothing should not become Var + nothing.
        if (/^[A-Za-z]/.test(remainder)) {
          return source;
        }

        const operatorCommand = MATH_OPERATOR_MAP.get(operatorKey) ?? `\\${operatorKey}`;

        if (!remainder) {
          return operatorCommand;
        }

        return `${operatorCommand} ${remainder}`;
      }

      // Keep user-typed case for Greek symbols (e.g. \Gamma vs \gamma).
      const finalKey = greekKey ? commandSource.slice(0, matchedKey.length) : commandKey ?? matchedKey;
      const command = `\\${finalKey}`;

      if (!remainder) {
        return command;
      }

      return `${command} ${remainder}`;
    }

    return source;
  }

  if (/^\d+$/.test(source)) {
    return source;
  }

  if (source === "E") {
    return "\\mathbb{E} ";
  }

  if (source === "P") {
    return "\\mathbb{P} ";
  }

  if (/^[A-Z]{2,}$/.test(source)) {
    return `\\text{${source}}`;
  }

  // First check case-sensitive map for Greek letters (to distinguish Gamma from gamma)
  if (GREEK_LATEX_MAP.has(source)) {
    return GREEK_LATEX_MAP.get(source) + " ";
  }

  const lowered = source.toLowerCase();

  // Then check lowercase maps
  if (GREEK_LATEX_MAP.has(lowered)) {
    return GREEK_LATEX_MAP.get(lowered) + " ";
  }

  if (MATH_COMMAND_MAP.has(lowered)) {
    return MATH_COMMAND_MAP.get(lowered) + " ";
  }

  if (MATH_OPERATOR_MAP.has(lowered)) {
    return MATH_OPERATOR_MAP.get(lowered) + " ";
  }

  return source;
}

function normalizeMathSource(expression) {
  const source = String(expression ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!source) {
    return "";
  }

  const rawTokens = source.match(/\\?[A-Za-z]+|\d+|\\.|[^A-Za-z\d\\\s]+|\s+/g) ?? [source];
  const normalizedTokens = [];
  let preserveGroupDepth = 0;
  let lastSignificantToken = "";

  for (const token of rawTokens) {
    if (/^\s+$/.test(token)) {
      normalizedTokens.push(" ");
      continue;
    }

    if (token === "{") {
      normalizedTokens.push(token);
      if (preserveGroupDepth > 0) {
        preserveGroupDepth += 1;
      } else if (/^\\[A-Za-z]+$/.test(lastSignificantToken) && !/^\\(begin|end)$/.test(lastSignificantToken)) {
        preserveGroupDepth += 1;
      }
      lastSignificantToken = token;
      continue;
    }

    if (token === "}") {
      normalizedTokens.push(token);
      if (preserveGroupDepth > 0) {
        preserveGroupDepth -= 1;
      }
      lastSignificantToken = token;
      continue;
    }

    if (preserveGroupDepth > 0) {
      normalizedTokens.push(token);
      if (!/^\s+$/.test(token)) {
        lastSignificantToken = token;
      }
      continue;
    }

    if (/^[A-Za-z]+$/.test(token)) {
      const parts = splitMathTokenWord(token);
      for (const part of parts) {
        normalizedTokens.push(normalizeMathToken(part));
      }
      lastSignificantToken = token;
      continue;
    }

    if (/^\\?[A-Za-z]+$/.test(token) || /^\\.$/.test(token) || /^\\/.test(token)) {
      normalizedTokens.push(normalizeMathToken(token));
      lastSignificantToken = token;
      continue;
    }

    normalizedTokens.push(token);
    lastSignificantToken = token;
  }

  return normalizedTokens.join("").replace(/\s+/g, " ").trim();
}

function hasLikelyMathOperator(source) {
  return (
    /\d\s*(?:=|<=|>=|<|>|[+\-*/])\s*\d/.test(source) ||
    /\b[A-Za-z]\b\s*(?:=|<=|>=|<|>|[+\-*/])\s*\b[A-Za-z]\b/.test(source) ||
    /\b[A-Za-z]\b\s*(?:=|<=|>=|<|>|[+\-*/])\s*\d/.test(source) ||
    /\d\s*(?:=|<=|>=|<|>|[+\-*/])\s*\b[A-Za-z]\b/.test(source) ||
    /\b[A-Za-z]\b_\{?[A-Za-z0-9]+/.test(source) ||
    /[A-Za-z0-9)\]}]\s*\^\s*\{?[A-Za-z0-9]+/.test(source)
  );
}

function looksLikeNaturalLanguage(source) {
  const englishWordCount = (source.match(/[A-Za-z]{3,}/g) ?? []).length;
  return englishWordCount >= 4;
}

function looksLikeSnakeCaseIdentifier(source) {
  const normalized = String(source ?? "").trim();

  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(normalized)) {
    return false;
  }

  if (!normalized.includes("_")) {
    return false;
  }

  if (/[{}\\^=+\-*/()[\]$]/.test(normalized)) {
    return false;
  }

  return normalized
    .split("_")
    .filter(Boolean)
    .every((part) => /^[A-Za-z0-9]+$/.test(part) && part.length >= 2);
}

function shouldRenderRawMathChunk(chunk) {
  const source = String(chunk ?? "").trim();

  if (!source) {
    return false;
  }

  if (source.includes("$")) {
    return false;
  }

  if (looksLikeSnakeCaseIdentifier(source)) {
    return false;
  }

  if (looksLikeNaturalLanguage(source) && !/\\[A-Za-z]+/.test(source)) {
    return false;
  }

  return (
    /\\[A-Za-z]+/.test(source) ||
    /(^|[^A-Za-z])(?:frac|sqrt|sum|int|left|right|cdot|times|pm|mp|leq|geq|neq|mathrm|text|operatorname|cov|var|poisson|exp|log|ln|sin|cos|tan|pr|alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|varpi|rho|varrho|sigma|varsigma|tau|phi|varphi|chi|psi|omega|E|P)(?=[^A-Za-z]|$)/i.test(
      source
    ) ||
    hasLikelyMathOperator(source) ||
    /\bP\([^)]+\)\s*=/.test(source) ||
    /\bE\[[^\]]+\]\s*=/.test(source) ||
    /^[A-Za-z]+\([^\)]*\)$/.test(source) ||
    /^[A-Za-z]+_[A-Za-z0-9{}]+$/.test(source) ||
    /^[A-Za-z]+\d+[A-Za-z0-9{}]*$/.test(source)
  );
}

function splitRawTextToSegments(text) {
  const source = String(text ?? "");
  const segments = [];
  let asciiBuffer = "";
  let groupDepth = 0;

  function flushAsciiBuffer() {
    if (!asciiBuffer) {
      return;
    }

    if (shouldRenderRawMathChunk(asciiBuffer)) {
      segments.push({ type: "math", text: asciiBuffer });
    } else {
      segments.push({ type: "text", text: asciiBuffer });
    }

    asciiBuffer = "";
  }

  for (const char of source) {
    if (char === "{") {
      groupDepth++;
    } else if (char === "}") {
      groupDepth = Math.max(0, groupDepth - 1);
    }

    if (groupDepth === 0 && char !== "}") {
      if (char === "\n") {
        flushAsciiBuffer();
        segments.push({ type: "break" });
        continue;
      }

      if (isCjkCharacter(char) || /[，。！？：；、“”‘’（）【】《》]/.test(char)) {
        flushAsciiBuffer();
        segments.push({ type: "text", text: char });
        continue;
      }
    }

    asciiBuffer += char;
  }

  flushAsciiBuffer();
  return segments;
}

function appendRawTextNodes(nodes, text, renderKeyPrefix = "raw") {
  const segments = splitRawTextToSegments(text);
  let localIndex = 0;

  for (const segment of segments) {
    if (segment.type === "math") {
      nodes.push(
        <MathFragment
          key={`${renderKeyPrefix}-math-${localIndex}`}
          expression={segment.text}
          displayMode={false}
        />
      );
      localIndex += 1;
      continue;
    }

    if (segment.type === "break") {
      nodes.push(<br key={`${renderKeyPrefix}-break-${localIndex}`} />);
      continue;
    }

    nodes.push(segment.text);
  }
}

function hasExplicitMathSyntax(text) {
  const source = String(text ?? "");

  return (
    /\\[A-Za-z]+/.test(source) ||
    /\bP\([^)]+\)\s*=/.test(source) ||
    /\bE\[[^\]]+\]\s*=/.test(source) ||
    /[A-Za-z0-9)\]}]\s*[_^]\s*\{?[A-Za-z0-9]/.test(source) ||
    /[A-Za-z0-9)\]}]\s*(?:=|<=|>=|<|>|[+\-*/])\s*[A-Za-z0-9({\[]/.test(source)
  );
}

function looksLikeMarkdownDecoratedText(text) {
  const source = String(text ?? "").trim();

  if (!source) {
    return false;
  }

  const hasMarkdownMarker =
    /\*\*[^*]+\*\*/.test(source) ||
    /__[^_]+__/.test(source) ||
    /`[^`]+`/.test(source);

  if (!hasMarkdownMarker) {
    return false;
  }

  return !hasExplicitMathSyntax(source);
}

function splitInlineSegments(text) {
  const source = String(text ?? "");
  const nodes = [];
  let cursor = 0;
  let keyIndex = 0;

  const pattern =
    /(`[^`]+`|\$\$(?:\\.|\n|[^$\\])+\$\$|\$(?:\\.|[^$\\])+?\$|\*\*[\s\S]+?\*\*|(?<!\w)__[\s\S]+?__(?!\w)|\*[^*$]+\*|(?<!\w)_[^_$]+_(?!\w)|!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\))/g;

  for (const match of source.matchAll(pattern)) {
    const token = match[0];
    const start = Number(match.index ?? 0);

    if (start > cursor) {
      appendRawTextNodes(nodes, source.slice(cursor, start), `raw-${keyIndex}`);
    }

    if (token.startsWith("`")) {
      nodes.push(<code key={`code-${keyIndex}`}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("$$")) {
      const expression = token.slice(2, -2);

      if (looksLikeMarkdownDecoratedText(expression)) {
        nodes.push(
          <span key={`display-math-fallback-${keyIndex}`}>{splitInlineSegments(expression)}</span>
        );
        keyIndex += 1;
        cursor = start + token.length;
        continue;
      }

      nodes.push(
        <MathFragment
          key={`display-math-${keyIndex}`}
          expression={expression}
          displayMode={true}
        />
      );
    } else if (token.startsWith("$")) {
      nodes.push(
        <MathFragment
          key={`inline-math-${keyIndex}`}
          expression={token.slice(1, -1)}
          displayMode={false}
        />
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(
        <strong key={`strong-${keyIndex}`}>{splitInlineSegments(token.slice(2, -2))}</strong>
      );
    } else if (token.startsWith("*") || token.startsWith("_")) {
      nodes.push(<em key={`em-${keyIndex}`}>{splitInlineSegments(token.slice(1, -1))}</em>);
    } else if (token.startsWith("![")) {
      const altMatch = token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
      const alt = altMatch?.[1] ?? "";
      const src = altMatch?.[2] ?? "";
      nodes.push(
        <img
          key={`img-${keyIndex}`}
          src={src}
          alt={alt}
          loading="lazy"
          className="markdown-image"
        />
      );
    } else {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const label = linkMatch?.[1] ?? token;
      const href = linkMatch?.[2] ?? "#";
      nodes.push(
        <a
          key={`link-${keyIndex}`}
          href={href}
          target="_blank"
          rel="noreferrer"
        >
          {label}
        </a>
      );
    }

    keyIndex += 1;
    cursor = start + token.length;
  }

  if (cursor < source.length) {
    appendRawTextNodes(nodes, source.slice(cursor), `raw-${keyIndex}`);
  }

  return nodes;
}

function renderMathMarkup(expression, displayMode) {
  const source = normalizeMathSource(expression);

  if (!source) {
    return "";
  }

  try {
    const markup = katex.renderToString(source, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      output: "html"
    });

    if (markup.includes("katex-error") || markup.includes("color:#cc0000") || markup.includes("color:#e50000")) {
      throw new Error("katex render error");
    }

    return markup;
  } catch {
    const escaped = source
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    return `<span class="markdown-math-fallback">${escaped}</span>`;
  }
}

function MathFragment({ expression, displayMode }) {
  const markup = renderMathMarkup(expression, displayMode);
  const className = displayMode ? "markdown-math display" : "markdown-math inline";
  const Tag = displayMode ? "div" : "span";

  return <Tag className={className} dangerouslySetInnerHTML={{ __html: markup }} />;
}

function flushParagraph(buffer, blocks) {
  if (buffer.length === 0) {
    return;
  }

  let text = buffer.join("\n");
  if (shouldRenderAsDisplayMath(text)) {
    if (text.startsWith("$$") && text.endsWith("$$")) {
      text = text.slice(2, -2).trim();
    } else if (text.startsWith("\\[") && text.endsWith("\\]")) {
      text = text.slice(2, -2).trim();
    }

    const parts = text.split(/(?:\$\$)+/);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].trim()) {
        appendMathFenceBlock(blocks, parts[i]);
      }
    }

    buffer.length = 0;
    return;
  }

  blocks.push({
    type: "paragraph",
    text
  });
  buffer.length = 0;
}

function flushList(currentList, blocks) {
  if (!currentList || currentList.items.length === 0) {
    return;
  }

  blocks.push({
    type: "list",
    ordered: currentList.ordered,
    items: [...currentList.items]
  });
  currentList.items.length = 0;
  currentList.ordered = false;
}

function flushQuote(currentQuote, blocks) {
  if (!currentQuote || currentQuote.lines.length === 0) {
    return;
  }

  blocks.push({
    type: "quote",
    text: currentQuote.lines.join("\n")
  });
  currentQuote.lines.length = 0;
}

function isLikelyMathText(text) {
  const source = String(text ?? "").trim();

  if (!source) {
    return false;
  }

  if (source.includes("$")) {
    return false;
  }

  if (looksLikeMarkdownDecoratedText(source)) {
    return false;
  }

  if (
    looksLikeNaturalLanguage(source) &&
    !/\\[A-Za-z]+/.test(source) &&
    !/\bP\([^)]+\)\s*=/.test(source) &&
    !/\bE\[[^\]]+\]\s*=/.test(source)
  ) {
    return false;
  }

  const mathHint =
    /\\(frac|sum|int|begin|end|left|right|cdot|times|pm|mp|leq|geq|neq|mathrm|text|operatorname)\b/.test(
      source
    ) ||
    /\\[a-zA-Z]+/.test(source) ||
    /(^|[^A-Za-z])(?:alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|varpi|rho|varrho|sigma|varsigma|tau|phi|varphi|chi|psi|omega)(?=[^A-Za-z]|$)/i.test(
      source
    ) ||
    hasLikelyMathOperator(source) ||
    /\bP\([^)]+\)\s*=/.test(source) ||
    /\bE\[[^\]]+\]\s*=/.test(source);

  if (!mathHint) {
    return false;
  }

  return !/[。！？：:；;，,]/.test(source) || source.includes("\\begin{");
}

function shouldRenderAsDisplayMath(text) {
  const source = String(text ?? "").trim();

  if (!source) {
    return false;
  }

  if (/^\$\$[\s\S]*\$\$$/.test(source)) {
    return true;
  }

  if (source.includes("$$")) {
    return isLikelyMathText(source.replace(/\$\$/g, ""));
  }

  if (source.includes("\n")) {
    return isLikelyMathText(source);
  }

  return isLikelyMathText(source);
}

function splitTableRow(line) {
  const source = String(line ?? "").trim();

  if (!source.includes("|")) {
    return [source];
  }

  const trimmed = source.replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let current = "";
  let inCodeSpan = false;
  let mathDelimiter = "";

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    const nextChar = trimmed[index + 1] ?? "";

    if (char === "\\") {
      if (!inCodeSpan && (nextChar === "|" || nextChar === "`" || nextChar === "$" || nextChar === "\\")) {
        current += nextChar;
        index += 1;
        continue;
      }

      current += char;
      continue;
    }

    if (char === "`" && !mathDelimiter) {
      inCodeSpan = !inCodeSpan;
      current += char;
      continue;
    }

    if (!inCodeSpan && char === "$") {
      const delimiter = nextChar === "$" ? "$$" : "$";

      if (!mathDelimiter) {
        mathDelimiter = delimiter;
      } else if (mathDelimiter === delimiter) {
        mathDelimiter = "";
      }

      current += delimiter;
      if (delimiter === "$$") {
        index += 1;
      }
      continue;
    }

    if (char === "|" && !inCodeSpan && !mathDelimiter) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function isTableSeparatorCell(cell) {
  // Be tolerant with model output that uses "--" separators instead of "---".
  return /^:?-{2,}:?$/.test(String(cell ?? "").replace(/\s+/g, ""));
}

function isTableSeparatorRow(line) {
  const cells = splitTableRow(line);
  return cells.length > 1 && cells.every((cell) => isTableSeparatorCell(cell));
}

function parseTableAlignment(cell) {
  const text = String(cell ?? "").trim();

  if (text.startsWith(":") && text.endsWith(":")) {
    return "center";
  }

  if (text.startsWith(":")) {
    return "left";
  }

  if (text.endsWith(":")) {
    return "right";
  }

  return "left";
}

function parseTableBlock(lines, startIndex) {
  const headerLine = lines[startIndex];
  const separatorLine = lines[startIndex + 1];

  if (!headerLine || !separatorLine || !headerLine.includes("|") || !isTableSeparatorRow(separatorLine)) {
    return null;
  }

  const headers = splitTableRow(headerLine);
  const alignments = splitTableRow(separatorLine).map((cell) => parseTableAlignment(cell));
  const rows = [];
  let cursor = startIndex + 2;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (!line.trim() || !line.includes("|")) {
      break;
    }

    const rowCells = splitTableRow(line);
    if (rowCells.length < 2) {
      break;
    }

    rows.push(rowCells);
    cursor += 1;
  }

  return {
    block: {
      type: "table",
      headers,
      alignments,
      rows
    },
    nextIndex: cursor
  };
}

function appendMathFenceBlock(blocks, rawText) {
  const text = String(rawText ?? "").trim();

  if (!text) {
    return;
  }

  const lacksExplicitMath = !hasExplicitMathSyntax(text);
  const looksLikeCjkText = /[\u3400-\u9fff]/.test(text) && !/[=+\-*/^_]/.test(text);
  const shouldFallbackToParagraph =
    looksLikeMarkdownDecoratedText(text) ||
    (looksLikeNaturalLanguage(text) && lacksExplicitMath) ||
    (looksLikeCjkText && lacksExplicitMath);

  if (shouldFallbackToParagraph) {
    blocks.push({
      type: "paragraph",
      text
    });
    return;
  }

  blocks.push({
    type: "math",
    text,
    displayMode: true
  });
}

function parseMarkdownBlocks(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  const paragraphBuffer = [];
  const currentList = { ordered: false, items: [] };
  const currentQuote = { lines: [] };
  let codeFence = null;
  let mathFence = null;

  function flushAll() {
    flushParagraph(paragraphBuffer, blocks);
    flushList(currentList, blocks);
    flushQuote(currentQuote, blocks);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const codeFenceMatch = line.match(/^\s{0,3}```(\w+)?\s*$/);

    if (codeFence) {
      if (/^\s{0,3}```\s*$/.test(line)) {
        blocks.push({
          type: "code",
          language: codeFence.language,
          text: codeFence.lines.join("\n")
        });
        codeFence = null;
      } else {
        codeFence.lines.push(line);
      }
      continue;
    }

    if (mathFence) {
      if (/^\$\$\s*$/.test(line.trim())) {
        appendMathFenceBlock(blocks, mathFence.lines.join("\n"));
        mathFence = null;
      } else {
        mathFence.lines.push(line);
      }
      continue;
    }

    if (codeFenceMatch) {
      flushAll();
      codeFence = {
        language: codeFenceMatch[1] ?? "",
        lines: []
      };
      continue;
    }

    if (/^\$\$\s*$/.test(line.trim())) {
      flushAll();
      mathFence = {
        lines: []
      };
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      flushAll();
      blocks.push({ type: "hr" });
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushAll();
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        text: headingMatch[2]
      });
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph(paragraphBuffer, blocks);
      flushList(currentList, blocks);
      currentQuote.lines.push(quoteMatch[1]);
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      flushParagraph(paragraphBuffer, blocks);
      flushQuote(currentQuote, blocks);
      const ordered = /\d+\./.test(listMatch[2]);

      if (currentList.items.length === 0) {
        currentList.ordered = ordered;
      } else if (currentList.ordered !== ordered) {
        flushList(currentList, blocks);
        currentList.ordered = ordered;
      }

      currentList.items.push(listMatch[3]);
      continue;
    }

    const tableResult = parseTableBlock(lines, index);
    if (tableResult) {
      flushParagraph(paragraphBuffer, blocks);
      flushList(currentList, blocks);
      flushQuote(currentQuote, blocks);
      blocks.push(tableResult.block);
      index = tableResult.nextIndex - 1;
      continue;
    }

    flushList(currentList, blocks);
    flushQuote(currentQuote, blocks);
    paragraphBuffer.push(line);
  }

  if (codeFence) {
    blocks.push({
      type: "code",
      language: codeFence.language,
      text: codeFence.lines.join("\n")
    });
  }

  if (mathFence) {
    appendMathFenceBlock(blocks, mathFence.lines.join("\n"));
  }

  flushParagraph(paragraphBuffer, blocks);
  flushList(currentList, blocks);
  flushQuote(currentQuote, blocks);

  return blocks;
}

function preprocessMarkdown(text) {
  let content = String(text ?? "");
  if (!content) return "";

  // 1. Handle Code Fences (```)
  const codeFenceMatches = content.match(/^\s{0,3}```/gm);
  if (codeFenceMatches && codeFenceMatches.length % 2 !== 0) {
    content += "\n```";
  }

  // 2. Handle Display Math ($$)
  const mathFenceMatches = content.match(/\$\$/g);
  if (mathFenceMatches && mathFenceMatches.length % 2 !== 0) {
    content += "\n$$";
  }

  // 3. Handle Inline Tokens (Bold, Italic, Code)
  // We use a simple stack-based or count-based approach for common inline markers
  const markers = [
    { char: "**", regex: /\*\*/g },
    { char: "__", regex: /__/g },
    { char: "*", regex: /\*/g },
    { char: "_", regex: /_/g },
    { char: "`", regex: /`/g }
  ];

  for (const { char, regex } of markers) {
    const matches = content.match(regex);
    if (matches && matches.length % 2 !== 0) {
      // If it's a single asterisk or underscore, be careful as they are often used alone
      if ((char === "*" || char === "_") && /\s$/.test(content)) {
        continue;
      }
      content += char;
    }
  }

  return content;
}

function MarkdownMessageComponent({ content, className = "" }) {
  const processedContent = useMemo(() => preprocessMarkdown(content), [content]);
  const blocks = useMemo(() => parseMarkdownBlocks(processedContent), [processedContent]);

  if (blocks.length === 0) {
    return <p className={`markdown markdown-empty ${className}`.trim()}>...</p>;
  }

  return (
    <div className={`markdown ${className}`.trim()}>
      {blocks.map((block, blockIndex) => {
        if (block.type === "heading") {
          const Tag = `h${Math.min(Math.max(block.level, 1), 6)}`;
          return (
            <Tag key={`heading-${blockIndex}`} className={`markdown-heading level-${block.level}`}>
              {splitInlineSegments(block.text)}
            </Tag>
          );
        }

        if (block.type === "code") {
          return (
            <pre key={`code-${blockIndex}`} className="markdown-code-block">
              <code>{block.text}</code>
            </pre>
          );
        }

        if (block.type === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag key={`list-${blockIndex}`} className="markdown-list">
              {block.items.map((item, itemIndex) => (
                <li key={`list-item-${blockIndex}-${itemIndex}`}>{splitInlineSegments(item)}</li>
              ))}
            </ListTag>
          );
        }

        if (block.type === "quote") {
          return (
            <blockquote key={`quote-${blockIndex}`} className="markdown-quote">
              <p>{splitInlineSegments(block.text)}</p>
            </blockquote>
          );
        }

        if (block.type === "math") {
          return (
            <div key={`math-${blockIndex}`} className="markdown-math-block">
              <MathFragment expression={block.text} displayMode={Boolean(block.displayMode)} />
            </div>
          );
        }

        if (block.type === "table") {
          return (
            <div key={`table-${blockIndex}`} className="markdown-table-wrap">
              <table className="markdown-table">
                <thead>
                  <tr>
                    {block.headers.map((cell, cellIndex) => (
                      <th
                        key={`table-head-${blockIndex}-${cellIndex}`}
                        className={`markdown-table-cell is-${block.alignments[cellIndex] ?? "left"}`}
                      >
                        {splitInlineSegments(cell)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`table-row-${blockIndex}-${rowIndex}`}>
                      {block.headers.map((_, cellIndex) => (
                        <td
                          key={`table-cell-${blockIndex}-${rowIndex}-${cellIndex}`}
                          className={`markdown-table-cell is-${block.alignments[cellIndex] ?? "left"}`}
                        >
                          {splitInlineSegments(row[cellIndex] ?? "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        if (block.type === "hr") {
          return <hr key={`hr-${blockIndex}`} className="markdown-hr" />;
        }

        return (
          <p key={`paragraph-${blockIndex}`} className="markdown-paragraph">
            {splitInlineSegments(block.text)}
          </p>
        );
      })}
    </div>
  );
}

export const MarkdownMessage = memo(
  MarkdownMessageComponent,
  (prevProps, nextProps) =>
    String(prevProps?.content ?? "") === String(nextProps?.content ?? "") &&
    String(prevProps?.className ?? "") === String(nextProps?.className ?? "")
);
