/* 数学表达式渲染（说明书 §3「LaTeX：$...$ 行内、$$...$$ 块级」）。

   背景：`skills-core.js` 的提示词明确要求模型用 `$...$` / `$$...$$` 输出数学
   （derivations 技能要求展开推导）——但在此之前**界面完全不渲染**，用户看到的是
   原始 TeX 源码。本模块补上渲染。

   设计取舍（刻意的）：
   · **零依赖、HTML 排版**——不引入 KaTeX/MathJax（体积与离线约束）。分式用 flex 两行 +
     横线，根号用 `√` + 上划线，上下标用 `<sup>`/`<sub>`。
   · **支持的语法是有限的、且边界明确**：不认识的 `\命令` **原样显示**（有断言），
     不做"看起来在工作"的假渲染——科研场景下，把公式渲染错比不渲染更糟。
   · 输出全部转义：本模块生成标签，内容一律 `esc`（有断言）。
   · 递归深度有上限（深嵌套原样输出），且渲染必须**永远终止**（有断言）。 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MathRender = api;
})(globalThis, root => {
  'use strict';

  const esc = value => String(value == null ? '' : value)
    .replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  const MAX_DEPTH = 12;

  // 希腊字母与常用符号：`\name` → 字符。
  const SYMBOLS = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
    theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ',
    rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    times: '×', cdot: '⋅', pm: '±', mp: '∓', div: '÷', ast: '∗', star: '⋆', circ: '∘', bullet: '∙',
    le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡', propto: '∝', sim: '∼', simeq: '≃', cong: '≅',
    to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐', leftrightarrow: '↔', mapsto: '↦', implies: '⟹', iff: '⟺',
    in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅',
    forall: '∀', exists: '∃', nexists: '∄', neg: '¬', land: '∧', lor: '∨', partial: '∂', nabla: '∇', infty: '∞',
    sum: '∑', prod: '∏', int: '∫', oint: '∮', iint: '∬', lim: 'lim',
    cdots: '⋯', dots: '…', ldots: '…', vdots: '⋮', ddots: '⋱',
    angle: '∠', perp: '⊥', parallel: '∥', therefore: '∴', because: '∵', prime: '′', degree: '°',
    lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋', langle: '⟨', rangle: '⟩', lVert: '‖', rVert: '‖', vert: '|', Vert: '‖'
  };

  // 正体命令（函数名、文本）：`\sin` → sin（正体），`\text{…}` → 正体文本。
  const UPRIGHT = ['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
    'log', 'ln', 'lg', 'exp', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker', 'deg', 'gcd', 'hom', 'arg', 'Pr',
    'mod', 'bmod', 'pmod'];

  const SPACES = { ',': '0.17em', ':': '0.22em', ';': '0.28em', '!': '-0.17em', ' ': '0.28em', quad: '1em', qquad: '2em' };

  // 读取一个 `{…}` 分组（支持嵌套）；没有花括号时读取单个原子（一个字符或一条命令）。
  function readGroup(tex, index) {
    let i = index;
    while (i < tex.length && /\s/.test(tex[i])) i += 1;
    if (tex[i] !== '{') {
      if (i >= tex.length) return { body: '', next: i };
      if (tex[i] === '\\') {
        const match = /^\\[A-Za-z]+/.exec(tex.slice(i));
        const command = match ? match[0] : tex.slice(i, i + 2);
        return { body: command, next: i + command.length };
      }
      return { body: tex[i], next: i + 1 };
    }
    let depth = 0;
    let j = i;
    for (; j < tex.length; j += 1) {
      if (tex[j] === '\\') { j += 1; continue; }
      if (tex[j] === '{') depth += 1;
      else if (tex[j] === '}') { depth -= 1; if (depth === 0) break; }
    }
    return { body: tex.slice(i + 1, j), next: j + 1 };
  }

  function renderRange(tex, depth) {
    if (depth > MAX_DEPTH) return esc(tex);
    let output = '';
    let i = 0;
    while (i < tex.length) {
      const char = tex[i];
      // 转义字符：\& \% \_ \# \$ \{ \}
      if (char === '\\' && /[&%_#$@{}]/.test(tex[i + 1] || '')) { output += esc(tex[i + 1]); i += 2; continue; }
      // 命令
      if (char === '\\') {
        const match = /^\\([A-Za-z]+)\s?/.exec(tex.slice(i));
        if (!match) { output += esc(char); i += 1; continue; }
        const name = match[1];
        const after = i + match[0].length;
        if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
          const numerator = readGroup(tex, after);
          const denominator = readGroup(tex, numerator.next);
          output += `<span class="math-frac"><span class="math-num">${renderRange(numerator.body, depth + 1)}</span><span class="math-den">${renderRange(denominator.body, depth + 1)}</span></span>`;
          i = denominator.next; continue;
        }
        if (name === 'sqrt') {
          let rest = after;
          let order = '';
          const optional = /^\s*\[([^\]]*)\]/.exec(tex.slice(rest));
          if (optional) { order = renderRange(optional[1], depth + 1); rest += optional[0].length; }
          const body = readGroup(tex, rest);
          output += `${order ? `<sup class="math-root-order">${order}</sup>` : ''}<span class="math-sqrt"><span class="math-radical">√</span><span class="math-radicand">${renderRange(body.body, depth + 1)}</span></span>`;
          i = body.next; continue;
        }
        if (name === 'text' || name === 'mathrm' || name === 'operatorname' || name === 'mathbf' || name === 'mathit') {
          const body = readGroup(tex, after);
          const weight = name === 'mathbf' ? ' math-bold' : '';
          const style = name === 'mathit' ? ' math-italic' : ' math-upright';
          output += `<span class="math-text${weight}${style}">${renderRange(body.body, depth + 1)}</span>`;
          i = body.next; continue;
        }
        if (name === 'left' || name === 'right') { i = after; continue; }   // 尺寸提示：忽略
        if (name === 'begin' || name === 'end') {
          // 环境（矩阵/对齐等）不支持：原样显示整条命令，避免渲染出错误结构。
          output += esc(match[0].trimEnd());
          i = after; continue;
        }
        if (Object.prototype.hasOwnProperty.call(SPACES, name)) {
          output += `<span class="math-space" style="width:${SPACES[name]}"></span>`;
          i = after; continue;
        }
        if (Object.prototype.hasOwnProperty.call(SYMBOLS, name)) {
          const symbol = SYMBOLS[name];
          // 大运算符（∑ ∏ ∫）的上下限用 <sub>/<sup> 贴在旁边
          output += `<span class="math-op">${esc(symbol)}</span>`;
          i = after; continue;
        }
        if (UPRIGHT.includes(name)) { output += `<span class="math-upright">${esc(name)}</span>`; i = after; continue; }
        // 不认识的命令：原样显示（诚实——宁可让用户看到源码，也不假装渲染）
        output += esc('\\' + name);
        i = after; continue;
      }
      // 上下标：^{…} / _{…} / ^x / _x
      if (char === '^' || char === '_') {
        const tag = char === '^' ? 'sup' : 'sub';
        const body = readGroup(tex, i + 1);
        if (!body.body) { output += esc(char); i += 1; continue; }
        output += `<${tag}>${renderRange(body.body, depth + 1)}</${tag}>`;
        i = body.next; continue;
      }
      // 分组：递归渲染（去掉花括号）
      if (char === '{') {
        const body = readGroup(tex, i);
        output += renderRange(body.body, depth + 1);
        i = body.next; continue;
      }
      if (char === '}') { output += esc(char); i += 1; continue; }
      if (char === '~') { output += '<span class="math-space" style="width:0.28em"></span>'; i += 1; continue; }
      // 普通字符成段输出（连续的非特殊字符一次 esc，减少节点）
      const plain = /^[^\\^_{}~]+/.exec(tex.slice(i))[0];
      output += esc(plain);
      i += plain.length;
    }
    return output;
  }

  function inlineMath(tex) {
    const body = String(tex == null ? '' : tex);
    if (!body.trim()) return null;
    return `<span class="math-inline" role="math" aria-label="${esc(body)}">${renderRange(body, 0)}</span>`;
  }

  function blockMath(tex) {
    const body = String(tex == null ? '' : tex);
    if (!body.trim()) return null;
    // 块级里的 `\\` 表示换行；按行渲染，逐行居中。
    const lines = body.split(/\\\\/).map(line => line.trim()).filter(Boolean);
    const html = lines.map(line => `<span class="math-line">${renderRange(line, 0)}</span>`).join('');
    return `<span class="math-block" role="math" aria-label="${esc(body)}">${html}</span>`;
  }

  root.MathRender = { inlineMath, blockMath, symbols: Object.keys(SYMBOLS), _pure: { renderRange, readGroup, esc } };
  return root.MathRender;
});
