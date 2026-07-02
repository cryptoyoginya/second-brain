#!/usr/bin/env node
// mcp-server.mjs — MCP-сервер (stdio) поверх markdown-vault второго мозга.
//
// Zero-dependency: только встроенные модули Node. Без БД и эмбеддингов —
// поиск по титулам/тексту/frontmatter (для ~55–100 страниц этого достаточно).
//
// Экспортируемые tools:
//   • kb_search    — поиск по vault (титул + текст + теги), фильтры frontmatter
//   • kb_think     — собрать контекст-синтез по вопросу (top-K страниц + каркас цитат)
//   • kb_backlinks — кто ссылается на страницу через [[вики-ссылку]]
//
// Конвенции vault (см. CLAUDE.md второго мозга):
//   • индексируем wiki/**.md, служебное исключаем (log.md, _*.md, _templates/)
//   • узлы графа = имена файлов (русские заголовки), их же цитируем
//   • ссылки [[Имя]] / [[Имя|алиас]] / [[Имя#секция]]
//   • frontmatter: type, domain, priority(1–5), verdict(keep|skim|reject), disputed, tags
//   • ГОТЧА: macOS хранит имена в NFD, текст в NFC → всё нормализуем в NFC.
//
// Запуск вручную (для проверки):
//   node tools/mcp-server.mjs   # затем слать JSON-RPC построчно в stdin

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Корень vault: на уровень выше tools/ ──────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT = join(HERE, '..');
const WIKI = join(VAULT, 'wiki');

const NFC = (s) => (s ?? '').normalize('NFC');
const log = (...a) => process.stderr.write('[sb-mcp] ' + a.join(' ') + '\n');

// Служебные страницы — исключаем из выдачи.
const EXCLUDE_NAMES = new Set(['log.md', '_отклонено.md', '_справочник.md'].map(NFC));
const EXCLUDE_DIRS = new Set(['_templates'].map(NFC));

// ── Загрузка и парсинг vault (свежая при каждом вызове — файлов мало) ──────
function walkWiki(dir = WIKI) {
  let out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const name = NFC(ent.name);
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(name) || name.startsWith('.')) continue;
      out = out.concat(walkWiki(join(dir, ent.name)));
    } else if (name.endsWith('.md') && !EXCLUDE_NAMES.has(name)) {
      out.push(join(dir, ent.name));
    }
  }
  return out;
}

function parseFrontmatter(text) {
  const fm = {};
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { fm, body: text };
  for (const line of m[1].split('\n')) {
    const mm = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!mm) continue;
    let [, k, v] = mm;
    v = v.trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v
        .slice(1, -1)
        .split(',')
        .map((x) => x.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      v = v.replace(/^["']|["']$/g, '');
      if (v === 'true') v = true;
      else if (v === 'false') v = false;
      else if (/^-?\d+$/.test(v)) v = Number(v);
    }
    fm[k] = v;
  }
  return { fm, body: text.slice(m[0].length) };
}

function loadPages() {
  const pages = [];
  for (const path of walkWiki()) {
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const text = NFC(raw);
    const { fm, body } = parseFrontmatter(text);
    const title = NFC(basename(path, '.md'));
    pages.push({
      path,
      rel: NFC(relative(VAULT, path)),
      title,
      titleLower: title.toLowerCase(),
      fm,
      body,
      bodyLower: body.toLowerCase(),
      tags: (Array.isArray(fm.tags) ? fm.tags : []).map((t) => NFC(String(t)).toLowerCase()),
    });
  }
  return pages;
}

// ── Токенизация (кириллица + латиница + цифры) ────────────────────────────
function tokens(s) {
  return NFC(s)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

function snippet(page, terms, len = 200) {
  const body = page.body.replace(/^#.*$/gm, '').replace(/>\s*\[!.*?\]/g, '').trim();
  const low = body.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = at === -1 ? 0 : Math.max(0, at - 60);
  return (start > 0 ? '…' : '') + body.slice(start, start + len).replace(/\s+/g, ' ').trim() + '…';
}

function scorePage(page, terms) {
  let score = 0;
  for (const t of terms) {
    if (page.titleLower.includes(t)) score += 5;
    if (page.tags.some((tag) => tag.includes(t))) score += 3;
    const occ = page.bodyLower.split(t).length - 1;
    if (occ > 0) score += Math.min(occ, 5);
  }
  return score;
}

// ── Реализация tools ──────────────────────────────────────────────────────
function passesFilters(page, { domain, min_priority, verdict }) {
  if (domain && NFC(String(page.fm.domain || '')).toLowerCase() !== NFC(domain).toLowerCase()) return false;
  if (verdict && NFC(String(page.fm.verdict || '')).toLowerCase() !== NFC(verdict).toLowerCase()) return false;
  if (min_priority != null && !(Number(page.fm.priority || 0) >= Number(min_priority))) return false;
  return true;
}

function kbSearch(args = {}) {
  const query = String(args.query || '');
  const top = Math.max(1, Math.min(Number(args.top || 8), 25));
  const terms = tokens(query);
  if (!terms.length) return { results: [], note: 'пустой запрос' };
  const pages = loadPages();
  const ranked = pages
    .filter((p) => passesFilters(p, args))
    .map((p) => ({ p, score: scorePage(p, terms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
  return {
    query,
    count: ranked.length,
    results: ranked.map(({ p, score }) => ({
      title: p.title,
      rel: p.rel,
      score,
      type: p.fm.type ?? null,
      domain: p.fm.domain ?? null,
      priority: p.fm.priority ?? null,
      verdict: p.fm.verdict ?? null,
      disputed: p.fm.disputed ?? false,
      tags: Array.isArray(p.fm.tags) ? p.fm.tags : [],
      snippet: snippet(p, terms),
    })),
  };
}

function kbBacklinks(args = {}) {
  const target = NFC(String(args.page || '')).replace(/\.md$/i, '');
  if (!target) return { page: '', backlinks: [] };
  const pages = loadPages();
  // [[Target]] | [[Target|alias]] | [[Target#section]]  (без учёта регистра первой буквы Obsidian не делает)
  const re = new RegExp('\\[\\[' + target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\||#|\\]\\])', 'iu');
  const hits = [];
  for (const p of pages) {
    if (p.title === target) continue;
    if (re.test(p.body)) {
      const i = p.body.search(re);
      hits.push({
        title: p.title,
        rel: p.rel,
        domain: p.fm.domain ?? null,
        context: p.body.slice(Math.max(0, i - 60), i + 80).replace(/\s+/g, ' ').trim(),
      });
    }
  }
  return { page: target, count: hits.length, backlinks: hits };
}

function kbThink(args = {}) {
  const question = String(args.question || '');
  const top = Math.max(1, Math.min(Number(args.top || 6), 12));
  // index.md — каталог, не источник для синтеза; исключаем из выдачи kb_think.
  const { results } = kbSearch({ query: question, top: top + 2 });
  const picked = results.filter((r) => r.title !== 'index').slice(0, top);
  const byRel = new Map(loadPages().map((p) => [p.rel, p]));
  const sources = picked.map((r, i) => {
    const page = byRel.get(r.rel);
    const excerpt = page ? page.body.replace(/\s+/g, ' ').slice(0, 700) : r.snippet;
    return `### [${i + 1}] [[${r.title}]]  (domain: ${r.domain ?? '—'}, verdict: ${r.verdict ?? '—'})\n${excerpt}…`;
  });
  const scaffold =
    `Вопрос: ${question}\n\n` +
    `Синтезируй ответ ТОЛЬКО из источников ниже. Правила:\n` +
    `- Цитируй страницы по заголовку в формате [[Заголовок]].\n` +
    `- Помечай FACT (прямо в источнике) vs INFERENCE (твоя связка). Не смешивай.\n` +
    `- Если источников мало или они спорят (disputed) — скажи об этом, не додумывай.\n` +
    `- Язык ответа — русский.\n\n` +
    `## Источники (top-${picked.length})\n\n${sources.join('\n\n')}`;
  return { question, used: picked.map((r) => r.title), prompt: scaffold };
}

// ── MCP tool-схемы ────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'kb_search',
    description:
      'Поиск по второму мозгу (Obsidian-vault): титул + текст + теги. Фильтры frontmatter: domain (ai|business|personal|religion|science), min_priority (1–5), verdict (keep|skim|reject). Возвращает top-K страниц с заголовком, метаданными и сниппетом. Цитируй по title.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'поисковый запрос (русский ок)' },
        domain: { type: 'string', description: 'фильтр по домену' },
        min_priority: { type: 'number', description: 'минимальный priority (1–5)' },
        verdict: { type: 'string', description: 'keep | skim | reject' },
        top: { type: 'number', description: 'сколько вернуть (по умолчанию 8)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kb_think',
    description:
      'Собрать контекст-синтез по вопросу: находит top-K релевантных страниц и возвращает готовый каркас для ответа с цитатами [[Заголовок]] и метками FACT/INFERENCE. Использовать, когда нужен связный ответ по нескольким страницам.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'вопрос для синтеза' },
        top: { type: 'number', description: 'сколько источников (по умолчанию 6)' },
      },
      required: ['question'],
    },
  },
  {
    name: 'kb_backlinks',
    description:
      'Кто ссылается на страницу через [[вики-ссылку]]. Принимает заголовок целевой страницы (с/без .md). Возвращает список цитирующих страниц с контекстом.',
    inputSchema: {
      type: 'object',
      properties: { page: { type: 'string', description: 'заголовок целевой страницы' } },
      required: ['page'],
    },
  },
];

const HANDLERS = { kb_search: kbSearch, kb_think: kbThink, kb_backlinks: kbBacklinks };

// ── JSON-RPC / MCP по stdio (newline-delimited) ───────────────────────────
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'second-brain', version: '0.1.0' },
    });
  } else if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    // notification — без ответа
  } else if (method === 'ping') {
    reply(id, {});
  } else if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
  } else if (method === 'tools/call') {
    const fn = HANDLERS[params?.name];
    if (!fn) return replyError(id, -32602, `неизвестный tool: ${params?.name}`);
    try {
      const out = fn(params.arguments || {});
      reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
    } catch (e) {
      reply(id, { content: [{ type: 'text', text: 'ошибка: ' + (e?.stack || e) }], isError: true });
    }
  } else if (id != null) {
    replyError(id, -32601, `метод не поддержан: ${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      log('bad JSON:', e.message);
      continue;
    }
    try {
      handle(msg);
    } catch (e) {
      log('handler crash:', e?.stack || e);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
log(`second-brain MCP готов. vault=${VAULT}`);
