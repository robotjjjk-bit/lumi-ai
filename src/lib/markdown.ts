import MarkdownIt from "markdown-it";
// @ts-expect-error: no type declarations available
import sub from "markdown-it-sub";
// @ts-expect-error: no type declarations available
import sup from "markdown-it-sup";
// @ts-expect-error: no type declarations available
import mark from "markdown-it-mark";
import hljs from "highlight.js";
import katex from "katex";
import "katex/dist/katex.min.css";

// === KaTeX Math Plugin for Markdown-It ===

function mathInline(state: any, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;

  // Try $...$ delimiter
  if (src[pos] === "$" && src[pos + 1] !== "$") {
    const start = pos + 1;
    let end = start;
    while (end < state.posMax && src[end] !== "$") {
      if (src[end] === "\\") end++;
      end++;
    }
    if (end >= state.posMax) return false;
    const content = src.slice(start, end).trim();
    if (!content) return false;
    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.content = content;
      token.markup = "$";
    }
    state.pos = end + 1;
    return true;
  }

  // Try \(...\) delimiter
  if (src[pos] === "\\" && src[pos + 1] === "(") {
    const start = pos + 2;
    const closeIdx = src.indexOf("\\)", start);
    if (closeIdx === -1 || closeIdx >= state.posMax) return false;
    const content = src.slice(start, closeIdx).trim();
    if (!content) return false;
    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.content = content;
      token.markup = "\\(";
    }
    state.pos = closeIdx + 2;
    return true;
  }

  return false;
}

function mathBlock(state: any, startLine: number, endLine: number, silent: boolean): boolean {
  const startPos = state.bMarks[startLine] + state.tShift[startLine];
  const maxPos = state.eMarks[startLine];
  const lineText = state.src.slice(startPos, maxPos).trim();

  // Determine opening delimiter: $$ or \[
  let closeDelim: string;
  if (lineText.startsWith("$$")) {
    closeDelim = "$$";
  } else if (lineText.startsWith("\\[")) {
    closeDelim = "\\]";
  } else {
    return false;
  }

  // Find closing delimiter
  let nextLine = startLine;
  let found = false;
  while (++nextLine < endLine) {
    const ls = state.bMarks[nextLine] + state.tShift[nextLine];
    const lm = state.eMarks[nextLine];
    const lt = state.src.slice(ls, lm).trim();
    if (lt === closeDelim) {
      found = true;
      break;
    }
  }
  if (!found) return false;
  if (silent) return true;

  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content = state.getLines(startLine + 1, nextLine, state.tShift[startLine], false).trim();
  token.markup = closeDelim;
  token.map = [startLine, nextLine + 1];
  state.line = nextLine + 1;
  return true;
}

function mathPlugin(md: MarkdownIt): void {
  md.inline.ruler.before("escape", "math_inline", mathInline);
  md.block.ruler.before("fence", "math_block", mathBlock, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  md.renderer.rules.math_inline = function (tokens, idx) {
    try {
      return katex.renderToString(tokens[idx].content, { throwOnError: false, output: "htmlAndMathml" });
    } catch {
      return `<code class="md-math-error">${md.utils.escapeHtml(tokens[idx].content)}</code>`;
    }
  };
  md.renderer.rules.math_block = function (tokens, idx) {
    try {
      return `<div class="md-math-block">${katex.renderToString(tokens[idx].content, { throwOnError: false, displayMode: true, output: "htmlAndMathml" })}</div>`;
    } catch {
      return `<pre class="md-math-error">${md.utils.escapeHtml(tokens[idx].content)}</pre>`;
    }
  };
}

// === Task List Post-Processor ===

function taskListPlugin(md: MarkdownIt): void {
  md.core.ruler.after("inline", "task_lists", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "inline") continue;
      const content = tokens[i].content;
      if (!content.startsWith("[ ] ") && !content.startsWith("[x] ") && !content.startsWith("[X] ")) continue;

      // Verify parent is a list item
      if (i < 2 || tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") continue;

      const checked = content[1] !== " ";
      tokens[i].content = content.slice(4);
      tokens[i - 2].attrJoin("class", "md-task-item");

      // Inject checkbox token at the start of inline children
      const checkbox = new state.Token("html_inline", "", 0);
      checkbox.content = `<input type="checkbox" class="md-task-checkbox" disabled${checked ? " checked" : ""} /> `;
      const children = tokens[i].children || [];
      children.unshift(checkbox);
      tokens[i].children = children;
    }
  });
}

function escapeHtmlBasic(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildHighlight(allowAuto: boolean): (str: string, lang: string) => string {
  return (str: string, lang: string): string => {
    const languageLabel = lang || "text";
    let highlighted: string;

    if (lang && hljs.getLanguage(lang)) {
      try {
        highlighted = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
      } catch {
        highlighted = escapeHtmlBasic(str);
      }
    } else if (allowAuto) {
      try {
        const result = hljs.highlightAuto(str);
        highlighted = result.value;
      } catch {
        highlighted = escapeHtmlBasic(str);
      }
    } else {
      // Streaming fast path: skip highlightAuto (mahal) — plain escaped code.
      highlighted = escapeHtmlBasic(str);
    }

    return (
      `<div class="md-code-block">` +
      `<div class="md-code-header">` +
      `<span class="md-code-lang">${escapeHtmlBasic(languageLabel)}</span>` +
      `<button class="md-code-copy" onclick="navigator.clipboard.writeText(this.closest('.md-code-block').querySelector('code').textContent).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)})">Copy</button>` +
      `</div>` +
      `<pre class="md-code-pre"><code class="hljs">${highlighted}</code></pre>` +
      `</div>`
    );
  };
}

function applyCommonRenderers(target: MarkdownIt): void {
  const targetDefaultLinkOpen =
    target.renderer.rules.link_open ||
    function (tokens: any, idx: number, options: any, _env: any, self: any) {
      return self.renderToken(tokens, idx, options);
    };

  target.renderer.rules.link_open = function (tokens, idx, options, env, self) {
    tokens[idx].attrSet("target", "_blank");
    tokens[idx].attrSet("rel", "noopener noreferrer");
    tokens[idx].attrJoin("class", "md-link");
    return targetDefaultLinkOpen(tokens, idx, options, env, self);
  };

  // Add class to inline code
  target.renderer.rules.code_inline = function (tokens, idx) {
    const content = escapeHtmlBasic(tokens[idx].content);
    return `<code class="md-inline-code">${content}</code>`;
  };

  // Add class to tables
  const targetDefaultTableOpen =
    target.renderer.rules.table_open ||
    function (tokens: any, idx: number, options: any, _env: any, self: any) {
      return self.renderToken(tokens, idx, options);
    };

  target.renderer.rules.table_open = function (tokens, idx, options, env, self) {
    tokens[idx].attrJoin("class", "md-table");
    return '<div class="md-table-wrap">' + targetDefaultTableOpen(tokens, idx, options, env, self);
  };

  const targetDefaultTableClose =
    target.renderer.rules.table_close ||
    function (tokens: any, idx: number, options: any, _env: any, self: any) {
      return self.renderToken(tokens, idx, options);
    };

  target.renderer.rules.table_close = function (tokens, idx, options, env, self) {
    return targetDefaultTableClose(tokens, idx, options, env, self) + '</div>';
  };

  // Add class to blockquotes
  const targetDefaultBlockquoteOpen =
    target.renderer.rules.blockquote_open ||
    function (tokens: any, idx: number, options: any, _env: any, self: any) {
      return self.renderToken(tokens, idx, options);
    };

  target.renderer.rules.blockquote_open = function (tokens, idx, options, env, self) {
    tokens[idx].attrJoin("class", "md-blockquote");
    return targetDefaultBlockquoteOpen(tokens, idx, options, env, self);
  };
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
  highlight: buildHighlight(true),
})
  .use(sub)
  .use(sup)
  .use(mark)
  .use(mathPlugin)
  .use(taskListPlugin);

applyCommonRenderers(md);

/**
 * Renders markdown text to HTML with full syntax highlighting
 * and Material Design 3 Expressive styling classes.
 */
export function renderMarkdown(text: string): string {
  return md.render(text);
}

// === Streaming (lightweight) render path ===
//
// renderMarkdownStream is intended for the per-token streaming path where
// renderMarkdown is currently called on every chunk. It produces the same
// HTML *structure* (same wrappers/classes for code blocks, links, tables,
// blockquotes, inline code) so swapping it in does not change layout, but
// skips the two heaviest per-render costs:
//   1. hljs.highlightAuto (tries every language per code fence) -> plain
//      escaped fallback when the fence language is unknown.
//   2. katex.renderToString per math token -> math source shown as plain
//      escaped text; full KaTeX only via renderMarkdown on settle/final.
// renderMarkdown above is intentionally left untouched (final messages).

function streamMathPlugin(mdStream: MarkdownIt): void {
  mdStream.inline.ruler.before("escape", "math_inline", mathInline);
  mdStream.block.ruler.before("fence", "math_block", mathBlock, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  // No KaTeX here: plain-text source so streaming never pays layout/parse cost.
  mdStream.renderer.rules.math_inline = function (tokens, idx) {
    return `<code class="md-math-stream">${mdStream.utils.escapeHtml(tokens[idx].content)}</code>`;
  };
  mdStream.renderer.rules.math_block = function (tokens, idx) {
    return `<pre class="md-math-stream-block">${mdStream.utils.escapeHtml(tokens[idx].content)}</pre>`;
  };
}

const mdStream = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
  highlight(str: string, lang: string): string {
    const languageLabel = lang || "text";
    let highlighted: string;

    if (lang && hljs.getLanguage(lang)) {
      try {
        highlighted = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
      } catch {
        highlighted = mdStream.utils.escapeHtml(str);
      }
    } else {
      // Streaming fast path: skip highlightAuto (heavy) -> plain escape.
      highlighted = mdStream.utils.escapeHtml(str);
    }

    return (
      `<div class="md-code-block">` +
      `<div class="md-code-header">` +
      `<span class="md-code-lang">${mdStream.utils.escapeHtml(languageLabel)}</span>` +
      `<button class="md-code-copy" onclick="navigator.clipboard.writeText(this.closest('.md-code-block').querySelector('code').textContent).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)})">Copy</button>` +
      `</div>` +
      `<pre class="md-code-pre"><code class="hljs">${highlighted}</code></pre>` +
      `</div>`
    );
  },
})
  .use(sub)
  .use(sup)
  .use(mark)
  .use(streamMathPlugin)
  .use(taskListPlugin);

// Same structural overrides as `md` so stream HTML matches final layout.
// Dedupe: link/table/blockquote identical dengan applyCommonRenderers;
// hanya code_inline dipertahankan memakai escape bawaan markdown-it
// (byte-identik dengan output stream sebelumnya).
applyCommonRenderers(mdStream);

mdStream.renderer.rules.code_inline = function (tokens, idx) {
  const content = mdStream.utils.escapeHtml(tokens[idx].content);
  return `<code class="md-inline-code">${content}</code>`;
};

/**
 * Lightweight markdown render for the streaming path (per-chunk calls).
 * Same structure as renderMarkdown minus highlightAuto + KaTeX.
 * Final/settled messages must keep using renderMarkdown (full output).
 */
export function renderMarkdownStream(text: string): string {
  return mdStream.render(text);
}

/** Alias agar pemanggil bisa memakai nama eksplisit streaming. */
export const renderMarkdownStreaming = renderMarkdownStream;

/**
 * Fast path paling murah saat token mengalir deras: tanpa markdown-it,
 * tanpa highlight, tanpa KaTeX. Hanya escape HTML + line-break.
 * Dipakai untuk frame intermediate; settle selalu memakai renderMarkdown
 * sehingga tampilan akhir identik dengan render penuh.
 */
export function renderPlainText(text: string): string {
  return escapeHtmlBasic(text).replace(/\n/g, "<br>");
}
