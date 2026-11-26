(() => {
  const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const parser = new marked.Marked({ gfm: true });
  parser.use({ renderer: {
    html(token) { return escape(token.text); },
    link(token) { return '<span class="md-link">' + this.parser.parseInline(token.tokens) + '</span>'; },
    image(token) { return escape(token.text || "Image"); },
    checkbox(token) { return token.checked ? "☑ " : "☐ "; },
  } });
  window.emberMarkdown = source => {
    const body = document.createElement("div");
    body.className = "markdown";
    try {
      const parsed = document.createElement("template");
      parsed.innerHTML = parser.parse(source);
      const tags = new Set("P H1 H2 H3 H4 H5 H6 UL OL LI STRONG EM DEL BLOCKQUOTE CODE PRE TABLE THEAD TBODY TR TH TD SPAN BR HR".split(" "));
      for (const node of parsed.content.querySelectorAll("*")) {
        if (!tags.has(node.tagName)) { node.replaceWith(document.createTextNode(node.textContent)); continue; }
        for (const name of node.getAttributeNames()) {
          if (name === "start" && node.tagName === "OL" && /^\d+$/.test(node.getAttribute(name))) continue;
          if (name === "class" && node.tagName === "SPAN" && node.className === "md-link") continue;
          node.removeAttribute(name);
        }
      }
      body.append(parsed.content);
    } catch {
      body.textContent = source;
    }
    return body;
  };
})();
