const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const { safeText } = require('./text');
function wrap(text, width) {
  width = Math.max(1, width);
  return safeText(String(text)).split(/\r?\n/).flatMap(line => {
    const chars = Array.from(line); const parts = [];
    do { parts.push(chars.splice(0, width).join('')); } while (chars.length);
    return parts;
  });
}
class Terminal extends EventEmitter {
  constructor(input, output, signal) {
    super(); this.input = input; this.output = output; this.signal = signal;
    this.tty = Boolean(output.isTTY); this.previousRaw = Boolean(input.isRaw);
    readline.emitKeypressEvents(input);
    this.key = (text, key = {}) => { if (key.ctrl && key.name === 'c') this.emit('interrupt'); else this.emit('key', text, key); };
    this.resize = () => this.redraw?.();
    input.on('keypress', this.key); output.on('resize', this.resize);
    input.setRawMode?.(true); input.resume();
    if (this.tty) output.write('\x1b[?1049h\x1b[?25l');
  }
  screen(lines, footer = '', focus = 0) {
    const width = Math.max(1, (this.output.columns || 80) - 1);
    const rows = Math.max(3, this.output.rows || 24);
    const content = lines.flatMap(line => wrap(line, width));
    const foot = wrap(footer, width).slice(0, Math.max(1, Math.floor(rows / 3)));
    const budget = Math.max(1, rows - foot.length - 1);
    const start = Math.max(0, Math.min(focus, content.length - budget));
    const visible = content.slice(start, start + budget);
    if (content.length > budget) visible.push(`Lines ${start + 1}-${Math.min(start + budget, content.length)}/${content.length}`.slice(0, width));
    const text = [...visible, ...foot].join('\n');
    this.output.write((this.tty ? '\x1b[H\x1b[2J' : '') + text + '\n');
  }
  wait(handler) {
    return new Promise((resolve, reject) => {
      const done = (value) => { cleanup(); resolve(value); };
      const key = (text, event) => handler(text, event, done);
      const abort = () => { cleanup(); reject(Object.assign(new Error('Stopped'), { name: 'AbortError' })); };
      const cleanup = () => { this.off('key', key); this.signal.removeEventListener('abort', abort); this.redraw = null; };
      this.on('key', key); this.signal.addEventListener('abort', abort, { once: true });
      if (this.signal.aborted) abort();
    });
  }
  async choose(title, entries) {
    const choices = entries.filter(e => e && e.value !== undefined);
    if (!choices.length) return null;
    let index = 0;
    const draw = () => {
      const lines = [title, ''];
      for (const entry of entries) lines.push(entry?.value === undefined ? '────────────────────────' : `${entry === choices[index] ? '›' : ' '} ${entry.label}`);
      const row = lines.slice(0, entries.indexOf(choices[index]) + 2).reduce((sum, line) => sum + wrap(line, Math.max(1, (this.output.columns || 80) - 1)).length, 0);
      this.screen(lines, '↑ ↓ select · Enter confirm · Esc back · q quit/back', Math.max(0, row - Math.max(2, (this.output.rows || 24) - 7)));
    };
    this.redraw = draw; draw();
    return this.wait((text, key, done) => {
      if (key.name === 'up') index = (index + choices.length - 1) % choices.length;
      else if (key.name === 'down' || key.name === 'tab') index = (index + 1) % choices.length;
      else if (key.name === 'return') return done(choices[index].value);
      else if (key.name === 'escape' || text === 'q') return done(null);
      else if (/^[1-9]$/.test(text ?? '') && Number(text) <= choices.length) index = Number(text) - 1;
      draw();
    });
  }
  async ask(title, initial = '') {
    let chars = Array.from(initial), cursor = chars.length;
    const draw = () => {
      const width = Math.max(1, (this.output.columns || 80) - 1);
      const cursorRow = wrap(title, width).length + 1 + Math.floor((cursor + 2) / width);
      this.screen([title, '', '> ' + chars.slice(0, cursor).join('') + '▏' + chars.slice(cursor).join('')], 'Enter save · Esc cancel — text shortcuts are disabled', Math.max(0, cursorRow - Math.max(1, (this.output.rows || 24) - 6)));
    };
    this.redraw = draw; draw();
    return this.wait((text, key, done) => {
      if (key.name === 'return') return done(chars.join('').trim());
      if (key.name === 'escape') return done(null);
      if (key.name === 'left') cursor = Math.max(0, cursor - 1);
      else if (key.name === 'right') cursor = Math.min(chars.length, cursor + 1);
      else if (key.name === 'home' || key.ctrl && key.name === 'a') cursor = 0;
      else if (key.name === 'end' || key.ctrl && key.name === 'e') cursor = chars.length;
      else if (key.name === 'backspace' && cursor > 0) chars.splice(--cursor, 1);
      else if (key.name === 'delete') chars.splice(cursor, 1);
      else if (text && !key.ctrl && !key.meta && !key.name?.startsWith('page')) {
        const add = Array.from(safeText(text).replace(/[\r\n\t]/g, ' '));
        chars.splice(cursor, 0, ...add); cursor += add.length;
      }
      draw();
    });
  }
  async message(title, body) {
    let offset = 0;
    const draw = () => this.screen([title, '', ...String(body).split('\n')], '↑ ↓ scroll · Enter / Esc back', offset);
    this.redraw = draw; draw();
    await this.wait((text, key, done) => {
      if (['return', 'escape'].includes(key.name) || text === 'q') return done();
      if (key.name === 'down') offset++;
      if (key.name === 'up') offset = Math.max(0, offset - 1);
      draw();
    });
  }
  close() {
    this.input.off('keypress', this.key); this.output.off('resize', this.resize);
    this.input.setRawMode?.(this.previousRaw); this.input.pause();
    if (this.tty) this.output.write('\x1b[?25h\x1b[?1049l');
    this.removeAllListeners();
  }
}
module.exports = { Terminal, wrap };
