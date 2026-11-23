// Note and section transclusions (`![[Note]]`, `![[Note#Heading]]`) for the
// reading views. Shared by the reading view and the docked note so both
// embed the same way: the HTML comes from the Rust core (raw HTML of a note
// is escaped there), cycles and depth are capped, and embedded notes update
// when their source changes.
import { api } from "./api";
import { embedImage, extensionOf, isImage } from "./attachments";
import { highlightCodeBlocks } from "./filetypes/markdown/codeHighlight";
import { enhanceReading } from "./filetypes/markdown/enhanceReading";
import { vault } from "./vault.svelte";

/** How deep embeds may nest before a placeholder stops them. */
const MAX_DEPTH = 5;

export interface EmbedOptions {
  /** Aborts a hydration run when the view goes away or renders anew. */
  signal: AbortSignal;
  maxDepth?: number;
  /** Source paths that changed: their wrappers are rendered again in place. */
  changed?: Set<string>;
}

/**
 * Replaces every `a[data-embed]` under `root` with its embedded content:
 * images as before, notes as a card with the rendered note (or section).
 * `rootPath` is the note the HTML belongs to; links inside an embed resolve
 * relative to the embedded note. Returns the paths of all embedded notes, so
 * the caller can re-hydrate when one of them changes (`changed`).
 */
export async function hydrateEmbeds(root: HTMLElement, rootPath: string, opts: EmbedOptions): Promise<Set<string>> {
  const embedded = new Set<string>();
  await hydrateLevel(root, rootPath, new Set([rootPath.toLowerCase()]), 0, embedded, opts);
  return embedded;
}

async function hydrateLevel(
  root: HTMLElement,
  contextPath: string,
  ancestors: Set<string>,
  depth: number,
  embedded: Set<string>,
  opts: EmbedOptions,
): Promise<void> {
  if (opts.signal.aborted) return;
  // Wrappers from an earlier run: only the ones whose source changed are
  // rendered again, the rest keep their content (and their scroll position).
  if (opts.changed) {
    for (const wrapper of root.querySelectorAll<HTMLElement>(".note-embed[data-embed-source]")) {
      // A changed parent was rendered again first and replaced this wrapper;
      // its detached copy must not be rendered a second time.
      if (!root.contains(wrapper)) continue;
      const source = wrapper.dataset.embedSource!;
      embedded.add(source);
      if (!opts.changed.has(source)) continue;
      const chain = ancestorChain(wrapper, contextPath);
      await renderInto(wrapper, source, wrapper.dataset.embedHeading || undefined, chain, chain.size - 1, embedded, opts);
    }
  }
  // The snapshot is taken before anything is replaced, so the links of a
  // nested embed are handled by its own recursion, not twice.
  const links = [...root.querySelectorAll<HTMLAnchorElement>("a[data-embed]")];
  for (const link of links) {
    if (opts.signal.aborted) return;
    const target = link.dataset.embed ?? "";
    if (!target) continue;
    if (isImage(target)) {
      const width = Number(link.textContent) || undefined;
      link.replaceWith(embedImage(target, width));
      continue;
    }
    const resolved = vault.resolveLink(target, contextPath);
    if (!resolved) {
      link.replaceWith(placeholder(`Note not found: ${target}`));
      continue;
    }
    // Only notes are transcluded; other files (PDF, canvas, …) stay links.
    if (extensionOf(resolved) !== "md") continue;
    embedded.add(resolved);
    const key = resolved.toLowerCase();
    if (ancestors.has(key)) {
      link.replaceWith(placeholder(`Circular embed: ${target}`));
      continue;
    }
    if (depth >= (opts.maxDepth ?? MAX_DEPTH)) {
      link.replaceWith(placeholder("Embed depth limit reached"));
      continue;
    }
    const heading = link.dataset.embedHeading || undefined;
    const wrapper = document.createElement("div");
    wrapper.className = "note-embed";
    wrapper.dataset.embedSource = resolved;
    if (heading) wrapper.dataset.embedHeading = heading;
    const title = document.createElement("a");
    title.className = "note-embed-title";
    title.href = "#";
    title.setAttribute("data-wikilink", resolved);
    const name = (resolved.split("/").pop() ?? resolved).replace(/\.md$/i, "");
    title.textContent = heading ? `${name}#${heading}` : name;
    const body = document.createElement("div");
    body.className = "prose note-embed-body";
    body.textContent = "Loading …";
    wrapper.append(title, body);
    link.replaceWith(wrapper);
    const chain = new Set(ancestors).add(key);
    await renderInto(wrapper, resolved, heading, chain, depth + 1, embedded, opts);
  }
}

/** Reads, renders and fills one embed wrapper; recursion handles its own embeds. */
async function renderInto(
  wrapper: HTMLElement,
  source: string,
  heading: string | undefined,
  ancestors: Set<string>,
  depth: number,
  embedded: Set<string>,
  opts: EmbedOptions,
): Promise<void> {
  const body = wrapper.querySelector<HTMLElement>(".note-embed-body");
  if (!body) return;
  // An open note embeds its live buffer, so edits show up right away.
  let text = vault.bufferedContent(source);
  if (text === undefined) {
    try {
      text = await api.readFile(source);
    } catch {
      if (!opts.signal.aborted) body.replaceChildren(placeholder(`Note not found: ${source}`));
      return;
    }
  }
  if (opts.signal.aborted) return;
  let html: string;
  try {
    html = (await api.renderMarkdown(text, heading)).html;
  } catch {
    if (!opts.signal.aborted) {
      body.replaceChildren(placeholder(heading ? `Section not found: ${heading}` : `The note could not be displayed.`));
    }
    return;
  }
  if (opts.signal.aborted) return;
  // The HTML is built in the Rust core; raw HTML from a note is escaped there.
  body.innerHTML = html;
  enhanceReading(body);
  void highlightCodeBlocks(body);
  await hydrateLevel(body, source, ancestors, depth, embedded, opts);
}

/** The embed chain of a wrapper: its own source and every embed above it. */
function ancestorChain(wrapper: HTMLElement, rootPath: string): Set<string> {
  const chain = new Set<string>([rootPath.toLowerCase()]);
  for (let el = wrapper.parentElement; el; el = el.parentElement) {
    const source = (el as HTMLElement).dataset?.embedSource;
    if (source) chain.add(source.toLowerCase());
  }
  chain.add(wrapper.dataset.embedSource!.toLowerCase());
  return chain;
}

function placeholder(text: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "dvoix-embed-missing";
  span.textContent = text;
  return span;
}

/**
 * The note a clicked link belongs to: inside an embed, relative links and
 * wikilinks resolve from the embedded note, not from the open one.
 */
export function embedContext(link: HTMLElement, rootPath: string): string {
  return link.closest<HTMLElement>("[data-embed-source]")?.dataset.embedSource ?? rootPath;
}

/** A relative markdown link target made vault-relative from its context note. */
export function resolveFromContext(href: string, contextPath: string): string {
  const target = href.split("#")[0];
  if (!target || target.startsWith("/")) return target;
  const parts = contextPath.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/**
 * Where a clicked markdown link goes: `./` and `../` are relative to the
 * note the link is written in (inside an embed: the embedded note), every
 * other target resolves like a wikilink from that note.
 */
export function linkTarget(href: string, contextPath: string): string {
  const target = href.split("#")[0];
  if (/^\.\.?\//.test(target)) return resolveFromContext(href, contextPath);
  return vault.resolveLink(target, contextPath) ?? target;
}