import { describeTool, resultText } from "./shared.mjs";
import { applyAgentResult, isAgentTool, newRun } from "./shared.mjs";
import { toolVerb } from "./shared.mjs";
import { isHiddenTool } from "./shared.mjs";
import { callState, callVerb } from "./shared.mjs";
import { closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = process.env.EMBER_CLAUDE_HOME
  ? join(process.env.EMBER_CLAUDE_HOME, ".claude", "projects")
  : join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
const tailBytes = 768 * 1024;
const cache = new Map();

function projectName(folder) {
  try {
    folder = realpathSync(folder);
  } catch {
    // The project's former checkout can be gone.
  }
  return folder.replace(/[^a-zA-Z0-9]/g, "-");
}

function candidates(chat) {
  const names = [...new Set(chat.folders.filter(Boolean).map(projectName))];
  return names.flatMap((name) => {
    if (name.length <= 200) return [name];
    return projects().filter((dir) => dir.startsWith(name.slice(0, 200) + "-"));
  });
}

let projectNames = [];
let projectsAt = -Infinity;
function projects() {
  if (Date.now() - projectsAt >= 30_000) {
    try {
      projectNames = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      projectNames = [];
    }
    projectsAt = Date.now();
  }
  return projectNames;
}

function newest(chat, dirs) {
  let best;
  for (const dir of dirs) {
    const file = join(root, dir, chat.id + ".jsonl");
    try {
      const stats = statSync(file);
      if (stats.isFile() && (!best || stats.mtimeMs > best.mtimeMs)) {
        best = { file, mtimeMs: stats.mtimeMs, size: stats.size };
      }
    } catch {
      // This session may have started in a different checkout.
    }
  }
  return best;
}

export function readTranscript(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buffer = Buffer.alloc(size - start);
    const count = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8", 0, count).split("\n");
    if (start) lines.shift();
    return transcriptItems(lines);

  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const clip = (value, max) => typeof value !== "string" ? "" : value.length > max ? value.slice(0, max) + "\n…" : value;

function transcriptItems(lines) {
  const items = new Map();
  const tools = new Map();
  const notifications = [];
  for (const line of lines) {
    if (!line || line.length > 512 * 1024) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || record.isSidechain || record.isCompactSummary) continue;
    const role = record.type;
    if (role !== "user" && role !== "assistant") continue;
    const content = record.message?.content;
    if (typeof content === "string" && content.startsWith("<task-notification>")) {
      notifications.push({
        id: /<task-id>(.*?)<\/task-id>/s.exec(content)?.[1]?.trim(),
        tool: /<tool-use-id>(.*?)<\/tool-use-id>/s.exec(content)?.[1]?.trim(),
        status: /<status>(.*?)<\/status>/s.exec(content)?.[1]?.trim(),
      });
      continue;
    }
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    for (const [index, block] of blocks.entries()) {
      if (!block) continue;
      if (block.type === "tool_result") {
        const tool = tools.get(block.tool_use_id);
        if (!tool) continue;
        tool.result = resultText(block.content);
        tool.status = block.is_error ? "error" : "done";
        if (isAgentTool(tool.name) && !block.is_error) {
          const run = applyAgentResult(newRun({}, 0), record.toolUseResult ?? tool.result, false, 0);
          if (run.background && run.status === "running") tool.background = run.agentId ?? tool.id;
        }
        if (tool.name === "Bash" && !block.is_error) {
          tool.background = /[Bb]ackground with ID:\s*([\w-]+)/.exec(tool.result)?.[1];
        }
        continue;
      }
      if (record.isMeta) continue;
      if (role === "assistant" && block.type === "tool_use" && typeof block.id === "string" &&
          typeof block.name === "string" && !isHiddenTool(block.name)) {
        if (tools.has(block.id)) continue;
        const view = describeTool(block.name, block.input, record.cwd);
        const tool = {
          role: "tool", id: block.id, name: block.name, summary: view.summary,
          lines: block.name === "Write" && typeof block.input?.content === "string" ? block.input.content.split("\n").length : undefined,
          command: clip(block.input?.command, 3200),
          diff: view.diff ? { oldText: clip(view.diff.oldText, 1200), newText: clip(view.diff.newText, 1200) } : undefined,
          status: "running", result: "", at: record.timestamp,
        };
        items.set("tool:" + tool.id, tool);
        tools.set(tool.id, tool);
      } else if (role === "assistant" && block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
        const id = "thought:" + (record.uuid ?? record.message?.id ?? items.size) + ":" + index;
        items.set(id, { role: "thinking", id, text: clip(block.thinking.trim(), 3600),
          ms: Number.isFinite(record.thinking_duration_ms) ? record.thinking_duration_ms : undefined, at: record.timestamp });
      } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        const id = (record.uuid ?? "line-" + items.size) + ":" + index;
        items.set("text:" + id, { role, id, text: clip(block.text.trim(), 3600), at: record.timestamp });
      }
    }
  }
  for (const notice of notifications) {
    const tool = tools.get(notice.tool) ?? [...tools.values()].find((item) => item.background && item.background === notice.id);
    if (!tool || !notice.status) continue;
    delete tool.background;
    tool.status = /failed|error|stopped/.test(notice.status) ? "error" : "done";
  }
  return [...items.values()].slice(-42).map((item) => {
    if (item.role !== "tool") return item;
    const state = callState(item, { background: Boolean(item.background) });
    return {
      ...item, state,
      verb: callVerb(state, { running: toolVerb(item.name, true), done: toolVerb(item.name, false) }),
    };
  });
}

export function transcriptFiles() {
  return new Map([...cache].filter(([, entry]) => entry.file).map(([id, entry]) => [id, entry.file]));
}

export function transcriptTails(chats) {
  const messages = new Map();
  for (const chat of chats) {
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(chat.id) || messages.has(chat.id)) continue;
    const prior = cache.get(chat.id);
    const known = candidates(chat);
    if (prior?.dir && !known.includes(prior.dir)) known.push(prior.dir);
    const at = Date.now();
    const checkAll = !prior || at - prior.searchedAt >= 30_000;
    const available = newest(chat, known) ?? (checkAll ? newest(chat, projects()) : undefined);
    if (!available) {
      cache.set(chat.id, { searchedAt: checkAll ? at : prior.searchedAt });
      messages.set(chat.id, []);
      continue;
    }
    const same = prior?.file === available.file && prior.mtimeMs === available.mtimeMs && prior.size === available.size;
    const tail = same ? prior.messages : readTranscript(available.file);
    const dir = available.file.slice(root.length + 1).split("/")[0];
    cache.set(chat.id, { ...available, dir, messages: tail, searchedAt: at });
    messages.set(chat.id, tail);
  }
  for (const id of cache.keys()) if (!messages.has(id)) cache.delete(id);
  return messages;
}
