/* 代码块语法高亮（说明书 §3「代码块｜语法高亮，多语言」与 §5.3「代码｜语法高亮」）。

   设计取舍（刻意的）：
   · **零依赖、逐字符扫描**——不引入第三方高亮库（体积与离线约束），也不用"全局正则替换"
     （那样会把字符串/注释里的关键字一起染色，属于错误高亮）。
   · **未知语言不猜测**：`highlight()` 返回 null，调用方回退为转义后的纯文本——
     宁可不高亮，也不做"看起来在工作"的假高亮。
   · **内容逐字不变**：任何输入都只**增加标记**，不改变可见文本（有断言锁定，
     并覆盖"未闭合字符串/注释"这类边界：一律原样输出到行尾/结尾，不吞内容）。
   · 扫描器必须**永远前进**（任何输入都终止，有断言）。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CodeHighlight = api;
})(globalThis, root => {
  'use strict';

  const esc = value => String(value == null ? '' : value)
    .replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  const COMMON_LITERALS = ['true', 'false', 'null', 'undefined', 'NaN', 'None', 'True', 'False', 'nil'];

  // 语言表：每个条目给出行注释、块注释、字符串引号与关键字。别名在 normalize 里归并。
  const LANGUAGES = {
    javascript: {
      line: ['//'], block: ['/*', '*/'], quotes: ['"', "'", '`'],
      keywords: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'new', 'class', 'extends', 'super', 'this', 'import', 'export', 'from', 'as', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of', 'delete', 'void', 'yield', 'static', 'get', 'set']
    },
    typescript: {
      line: ['//'], block: ['/*', '*/'], quotes: ['"', "'", '`'],
      keywords: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'default', 'break', 'continue', 'class', 'interface', 'type', 'enum', 'extends', 'implements', 'public', 'private', 'protected', 'readonly', 'import', 'export', 'from', 'as', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'new', 'this', 'super', 'typeof', 'keyof', 'in', 'of', 'namespace', 'declare', 'satisfies']
    },
    python: {
      line: ['#'], quotes: ['"', "'"],
      keywords: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'import', 'from', 'as', 'try', 'except', 'finally', 'raise', 'with', 'lambda', 'yield', 'global', 'nonlocal', 'assert', 'del', 'pass', 'and', 'or', 'not', 'in', 'is', 'async', 'await', 'match', 'case']
    },
    json: { line: [], quotes: ['"'], keywords: [] },
    shell: {
      line: ['#'], quotes: ['"', "'"],
      keywords: ['if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'case', 'esac', 'function', 'return', 'exit', 'export', 'local', 'readonly', 'source', 'set', 'unset', 'trap', 'echo', 'cd', 'ls', 'grep', 'sed', 'awk', 'cat', 'mkdir', 'rm', 'cp', 'mv', 'find', 'curl', 'git', 'npm', 'node', 'python3', 'pip', 'make', 'bash', 'sh']
    },
    css: { line: [], block: ['/*', '*/'], quotes: ['"', "'"], keywords: ['important', 'media', 'supports', 'keyframes', 'import', 'charset', 'font-face', 'root', 'from', 'to'] },
    sql: {
      line: ['--'], block: ['/*', '*/'], quotes: ["'", '"'],
      keywords: ['select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table', 'index', 'view', 'drop', 'alter', 'add', 'column', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'by', 'order', 'having', 'limit', 'offset', 'distinct', 'as', 'and', 'or', 'not', 'null', 'primary', 'key', 'foreign', 'references', 'default', 'union', 'case', 'when', 'then', 'else', 'end', 'with', 'asc', 'desc', 'count', 'sum', 'avg', 'min', 'max']
    },
    yaml: { line: ['#'], quotes: ['"', "'"], keywords: [] },
    markup: { line: [], block: ['<!--', '-->'], quotes: ['"', "'"], markup: true },
    c: {
      line: ['//'], block: ['/*', '*/'], quotes: ['"', "'"],
      keywords: ['int', 'long', 'short', 'char', 'float', 'double', 'void', 'unsigned', 'signed', 'struct', 'union', 'enum', 'typedef', 'static', 'const', 'extern', 'inline', 'volatile', 'register', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return', 'goto', 'sizeof', 'include', 'define', 'ifdef', 'ifndef', 'endif']
    },
    go: {
      line: ['//'], block: ['/*', '*/'], quotes: ['"', '`'],
      keywords: ['package', 'import', 'func', 'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'default', 'break', 'continue', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan', 'go', 'defer', 'select', 'nil', 'true', 'false']
    },
    rust: {
      line: ['//'], block: ['/*', '*/'], quotes: ['"', "'"],
      keywords: ['fn', 'let', 'mut', 'const', 'static', 'struct', 'enum', 'trait', 'impl', 'for', 'while', 'loop', 'if', 'else', 'match', 'return', 'use', 'mod', 'pub', 'crate', 'super', 'self', 'where', 'as', 'in', 'ref', 'move', 'async', 'await', 'dyn', 'unsafe', 'type']
    }
  };

  const ALIASES = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', python3: 'python',
    sh: 'shell', bash: 'shell', zsh: 'shell', shellscript: 'shell', console: 'shell', terminal: 'shell',
    html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
    yml: 'yaml',
    cpp: 'c', 'c++': 'c', h: 'c', hpp: 'c', cc: 'c', cxx: 'c', java: 'c', kotlin: 'c', swift: 'c', objectivec: 'c',
    golang: 'go', rs: 'rust', postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql'
  };

  function normalizeLanguage(language) {
    const name = String(language || '').trim().toLowerCase();
    if (!name) return null;
    if (Object.prototype.hasOwnProperty.call(LANGUAGES, name)) return name;
    const alias = ALIASES[name];
    return alias && Object.prototype.hasOwnProperty.call(LANGUAGES, alias) ? alias : null;
  }

  const isDigit = char => char >= '0' && char <= '9';
  const isWordStart = char => /[A-Za-z_$]/.test(char);
  const isWordChar = char => /[A-Za-z0-9_$]/.test(char);

  // 扫描一段并产出 HTML。任何分支都必须让 i 前进（否则会死循环，断言覆盖）。
  function scan(code, config) {
    const keywordSet = new Set(config.keywords || []);
    const literalSet = new Set(COMMON_LITERALS);
    let output = '';
    let i = 0;
    while (i < code.length) {
      const rest = code.slice(i);
      // 行注释
      const lineMark = (config.line || []).find(marker => marker && rest.startsWith(marker));
      if (lineMark) {
        const end = code.indexOf('\n', i);
        const stop = end === -1 ? code.length : end;
        output += `<span class="tok-comment">${esc(code.slice(i, stop))}</span>`;
        i = stop; continue;
      }
      // 块注释（未闭合则到结尾，原样收下，不吞内容）
      if (config.block && rest.startsWith(config.block[0])) {
        const close = code.indexOf(config.block[1], i + config.block[0].length);
        const stop = close === -1 ? code.length : close + config.block[1].length;
        output += `<span class="tok-comment">${esc(code.slice(i, stop))}</span>`;
        i = stop; continue;
      }
      // 字符串（支持 \ 转义；未闭合到行尾为止——不跨越换行，避免吞掉后续代码）
      const quote = (config.quotes || []).find(char => rest[0] === char);
      if (quote) {
        let j = i + 1;
        let closed = false;
        while (j < code.length) {
          if (code[j] === '\\') { j += 2; continue; }
          if (code[j] === quote) { closed = true; j += 1; break; }
          if (code[j] === '\n') break;
          j += 1;
        }
        const stop = closed ? j : Math.min(j, code.length);
        output += `<span class="tok-string">${esc(code.slice(i, stop))}</span>`;
        i = stop; continue;
      }
      // 数字：用正则一次匹配（逐字符扫描会把 `1+2` 的 `+` 也吞进来——属错误高亮）
      if (isDigit(rest[0]) || (rest[0] === '.' && isDigit(rest[1]))) {
        const numberMatch = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)/.exec(rest);
        const token = numberMatch ? numberMatch[0] : rest[0];
        output += `<span class="tok-number">${esc(token)}</span>`;
        i += token.length; continue;
      }
      // 标识符 / 关键字
      if (isWordStart(rest[0])) {
        let j = i;
        while (j < code.length && isWordChar(code[j])) j += 1;
        const word = code.slice(i, j);
        const lower = word.toLowerCase();
        if (keywordSet.has(word) || keywordSet.has(lower)) output += `<span class="tok-keyword">${esc(word)}</span>`;
        else if (literalSet.has(word)) output += `<span class="tok-literal">${esc(word)}</span>`;
        else output += esc(word);
        i = j; continue;
      }
      // 其余字符逐个输出（esc 后单字符）。这里必须至少前进 1，保证终止。
      output += esc(code[i]);
      i += 1;
    }
    return output;
  }

  // markup（HTML/XML）单独处理：标签名、属性名、注释、字符串。
  function scanMarkup(code) {
    let output = '';
    let i = 0;
    while (i < code.length) {
      const rest = code.slice(i);
      if (rest.startsWith('<!--')) {
        const close = code.indexOf('-->', i + 4);
        const stop = close === -1 ? code.length : close + 3;
        output += `<span class="tok-comment">${esc(code.slice(i, stop))}</span>`;
        i = stop; continue;
      }
      if (rest[0] === '<' && /^<\/?[A-Za-z!]/.test(rest)) {
        const close = code.indexOf('>', i);
        const stop = close === -1 ? code.length : close + 1;
        // 标签内部：标签名与属性名着色，属性值原样（作为字符串）
        output += esc(code.slice(i, stop)).replace(/^(&lt;\/?)([A-Za-z][\w-]*)/, (all, open, name) => `${open}<span class="tok-keyword">${name}</span>`);
        i = stop; continue;
      }
      if (rest[0] === '"' || rest[0] === "'") {
        const quote = rest[0];
        let j = i + 1;
        while (j < code.length && code[j] !== quote && code[j] !== '\n') j += 1;
        const stop = code[j] === quote ? j + 1 : j;
        output += `<span class="tok-string">${esc(code.slice(i, stop))}</span>`;
        i = stop; continue;
      }
      output += esc(code[i]);
      i += 1;
    }
    return output;
  }

  // 返回高亮后的 HTML；未知语言返回 null（调用方回退为纯转义文本）。
  function highlight(code, language) {
    const name = normalizeLanguage(language);
    if (!name) return null;
    const config = LANGUAGES[name];
    return config.markup ? scanMarkup(String(code ?? '')) : scan(String(code ?? ''), config);
  }

  root.CodeHighlight = { highlight, normalizeLanguage, languages: Object.keys(LANGUAGES), _pure: { scan, scanMarkup, esc } };
  return root.CodeHighlight;
});
