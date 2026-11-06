// 画面共通の小物
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICONS = {
  mic: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  play: '<path d="M8 5.5v13l10-6.5-10-6.5Z"/>',
  slow: '<path d="M4 17h16M7 13c0-3 2.2-5 5-5s5 2 5 5"/><circle cx="17.5" cy="13" r="1"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  send: '<path d="M4 12l16-8-6 16-3-7-7-1Z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
};

export const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

export function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => t.remove(), 3700);
}

// html はエスケープ済みの文字列を渡すこと
export function modal(html, { onClose } = {}) {
  const d = document.createElement('dialog');
  d.className = 'sheet';
  d.innerHTML = html;
  document.body.append(d);
  d.addEventListener('close', () => { d.remove(); onClose?.(); });
  d.addEventListener('click', (e) => {
    if (e.target === d || e.target.closest('[data-close]')) d.close();
  });
  d.showModal();
  return d;
}

export const fmtDate = (t) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

export const head = (title, back = '#/') => `
  <header class="bar">
    <a class="icon-btn" href="${esc(back)}" aria-label="戻る">${icon('back')}</a>
    <h1>${esc(title)}</h1>
    <span class="icon-btn"></span>
  </header>`;
