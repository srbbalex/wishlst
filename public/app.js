'use strict';

// ---------- Utilitare ----------
// Construim elementele DOM direct (fără innerHTML), ca textul introdus de utilizatori să nu poată rula cod.
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path, { method = 'GET', json, form } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (form) {
    opts.body = form;
  }
  let res;
  try { res = await fetch(path, opts); }
  catch { throw new Error('Nu m-am putut conecta la server.'); }
  let data = null;
  try { data = await res.json(); } catch { /* răspuns fără JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Ceva nu a mers. Încearcă din nou.');
    err.status = res.status;
    throw err;
  }
  return data;
}

function safeHref(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch { return null; }
}

// Micșorăm poza în browser înainte de trimitere: telefoanele fac poze de câțiva MB, iar serverul acceptă maxim 3 MB.
async function shrinkImage(file, maxSide = 1280) {
  let bmp;
  try { bmp = await createImageBitmap(file); }
  catch { throw new Error('Nu am putut citi poza. Încearcă un JPG sau PNG.'); }
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const hgt = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = hgt;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // fundal alb pentru PNG-urile transparente
  ctx.fillRect(0, 0, w, hgt);
  ctx.drawImage(bmp, 0, 0, w, hgt);
  if (bmp.close) bmp.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new Error('Nu am putut pregăti poza.');
  return blob;
}

const fmtPrice = (p) => (p === null || p === undefined ? null
  : new Intl.NumberFormat('ro-RO', { minimumFractionDigits: Number.isInteger(p) ? 0 : 2, maximumFractionDigits: 2 }).format(p) + ' lei');
const hearts = (n) => '♥'.repeat(n) + '♡'.repeat(3 - n);
const PRIORITY_LABEL = { 1: 'Ar fi drăguț', 2: 'Îmi doresc', 3: 'Foarte mult' };

let toastTimer;
function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2800);
}

// ---------- Stare ----------
const state = { me: null, tab: 'mine', mine: [], partner: [] };
const root = document.getElementById('app');

function mount(...nodes) { root.replaceChildren(...nodes); }

// ---------- Autentificare ----------
function renderAuth(mode = 'login') {
  const isLogin = mode === 'login';
  const err = h('p', { class: 'error', role: 'alert' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, isLogin ? 'Intră în cont' : 'Creează cont');

  const user = h('input', { type: 'text', id: 'u', autocomplete: 'username', required: true, maxlength: '20', autocapitalize: 'none' });
  const pass = h('input', { type: 'password', id: 'p', autocomplete: isLogin ? 'current-password' : 'new-password', required: true, minlength: isLogin ? null : '8' });
  const pass2 = h('input', { type: 'password', id: 'p2', autocomplete: 'new-password', required: true });

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (!isLogin && pass.value !== pass2.value) { err.textContent = 'Parolele nu coincid.'; return; }
      btn.disabled = true;
      try {
        state.me = await api(isLogin ? '/api/login' : '/api/register', { method: 'POST', json: { username: user.value, password: pass.value } });
        state.tab = 'mine';
        await renderApp();
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    },
  },
    h('div', { class: 'field' }, h('label', { for: 'u' }, 'Nume de utilizator'), user),
    h('div', { class: 'field' }, h('label', { for: 'p' }, 'Parolă'), pass,
      isLogin ? null : h('p', { class: 'hint' }, 'Minim 8 caractere.')),
    isLogin ? null : h('div', { class: 'field' }, h('label', { for: 'p2' }, 'Repetă parola'), pass2),
    err,
    btn,
  );

  mount(h('div', { class: 'auth-wrap' },
    h('div', { class: 'auth-card' },
      h('h1', null, '🎁 Wishlist pentru doi'),
      h('p', { class: 'sub' }, 'Fiecare își face lista, celălalt o vede — iar rezervările rămân surpriză.'),
      h('div', { class: 'seg', role: 'tablist' },
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(isLogin), onclick: () => renderAuth('login') }, 'Autentificare'),
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(!isLogin), onclick: () => renderAuth('register') }, 'Cont nou'),
      ),
      form,
    ),
  ));
  user.focus();
}

// ---------- Aplicația principală ----------
async function renderApp() {
  if (!state.me) return renderAuth();
  try {
    state.mine = await api('/api/items');
    state.partner = state.me.partner ? await api('/api/partner/items') : [];
  } catch (ex) {
    if (ex.status === 401) { state.me = null; return renderAuth(); }
    toast(ex.message);
  }
  draw();
}

function draw() {
  const me = state.me;
  const partnerName = me.partner ? me.partner.username : null;

  const tabs = h('div', { class: 'tabs', role: 'tablist' },
    h('button', { class: 'tab', role: 'tab', 'aria-selected': String(state.tab === 'mine'), onclick: () => { state.tab = 'mine'; draw(); } }, 'Lista mea'),
    h('button', { class: 'tab', role: 'tab', 'aria-selected': String(state.tab === 'partner'), onclick: () => { state.tab = 'partner'; draw(); } },
      partnerName ? `Lista lui ${partnerName}` : 'Conectează-te cu partenerul'),
  );

  mount(h('div', { class: 'container' },
    h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, '🎁 Wishlist'),
      h('div', { class: 'who' }, h('span', null, me.username),
        h('button', { class: 'btn small', onclick: logout }, 'Ieși')),
    ),
    tabs,
    state.tab === 'mine' ? viewMine() : (me.partner ? viewPartner() : viewPair()),
  ));
}

async function logout() {
  try { await api('/api/logout', { method: 'POST', json: {} }); } catch { /* ignorăm */ }
  state.me = null;
  renderAuth();
}

// ---------- Cardul unui cadou ----------
function giftCard(item, { mine }) {
  const href = item.url ? safeHref(item.url) : null;
  const imgSrc = item.image ? (item.image.startsWith('/uploads/') ? item.image : safeHref(item.image)) : null;
  const price = fmtPrice(item.price);

  const thumb = h('div', { class: 'thumb' },
    imgSrc ? h('img', { src: imgSrc, alt: item.name, loading: 'lazy', referrerpolicy: 'no-referrer' }) : '🎁',
    !mine && item.reserved ? h('span', { class: 'badge' }, '✓ Rezervat (surpriză!)') : null,
  );

  const actions = h('div', { class: 'actions' },
    href ? h('a', { class: 'btn small', href, target: '_blank', rel: 'noopener noreferrer' }, 'Vezi produsul') : null,
    mine ? h('button', { class: 'btn small', onclick: () => openItemDialog(item) }, 'Editează') : null,
    mine ? h('button', { class: 'btn small danger', onclick: () => removeItem(item) }, 'Șterge') : null,
    !mine ? h('button', {
      class: 'btn small ' + (item.reserved ? '' : 'primary'),
      onclick: () => toggleReserve(item),
    }, item.reserved ? 'Anulează' : 'Îl cumpăr eu') : null,
  );

  return h('article', { class: 'card' + (!mine && item.reserved ? ' reserved' : '') },
    thumb,
    h('div', { class: 'body' },
      h('h3', null, item.name),
      h('div', { class: 'meta' },
        h('span', { class: 'price' }, price || ''),
        h('span', { class: 'hearts', title: PRIORITY_LABEL[item.priority] }, hearts(item.priority)),
      ),
      item.notes ? h('p', { class: 'notes' }, item.notes) : null,
    ),
    actions,
  );
}

// ---------- Lista mea ----------
function viewMine() {
  return h('section', null,
    h('div', { class: 'toolbar' },
      h('h2', null, `Lista mea (${state.mine.length})`),
      h('button', { class: 'btn primary', onclick: () => openItemDialog(null) }, '+ Adaugă cadou'),
    ),
    state.me.partner
      ? h('div', { class: 'banner' }, `🙈 ${state.me.partner.username} vede lista ta, dar nu vei ști niciodată ce a rezervat.`)
      : h('div', { class: 'banner' }, 'Conectează-te cu partenerul din tab-ul alăturat ca să vă vedeți listele.'),
    state.mine.length
      ? h('div', { class: 'grid' }, state.mine.map((i) => giftCard(i, { mine: true })))
      : h('div', { class: 'empty' }, h('div', { class: 'big' }, '🎀'), h('p', null, 'Lista ta e goală. Adaugă primul lucru pe care ți-l dorești!')),
  );
}

async function removeItem(item) {
  if (!confirm(`Ștergi „${item.name}” din listă?`)) return;
  try {
    await api('/api/items/' + item.id, { method: 'DELETE' });
    state.mine = state.mine.filter((i) => i.id !== item.id);
    draw();
    toast('Șters.');
  } catch (ex) { toast(ex.message); }
}

// ---------- Lista partenerului ----------
function viewPartner() {
  const name = state.me.partner.username;
  const reservedCount = state.partner.filter((i) => i.reserved).length;
  return h('section', null,
    h('div', { class: 'toolbar' },
      h('h2', null, `Lista lui ${name} (${state.partner.length})`),
      h('button', { class: 'btn small', onclick: unlink }, 'Deconectează-mă'),
    ),
    h('div', { class: 'banner' }, `🤫 Când apeși „Îl cumpăr eu”, doar tu vezi rezervarea — ${name} nu primește nicio informație despre ea.${reservedCount ? ` Ai rezervat ${reservedCount}.` : ''}`),
    state.partner.length
      ? h('div', { class: 'grid' }, state.partner.map((i) => giftCard(i, { mine: false })))
      : h('div', { class: 'empty' }, h('div', { class: 'big' }, '⏳'), h('p', null, `${name} n-a adăugat încă nimic.`)),
  );
}

async function toggleReserve(item) {
  try {
    const updated = await api(`/api/partner/items/${item.id}/reserve`, { method: 'POST', json: { reserved: !item.reserved } });
    state.partner = state.partner.map((i) => (i.id === updated.id ? updated : i));
    draw();
    toast(updated.reserved ? 'Rezervat. E secret! 🤐' : 'Rezervare anulată.');
  } catch (ex) { toast(ex.message); }
}

async function unlink() {
  if (!confirm('Sigur te deconectezi de la partener? Rezervările se vor șterge.')) return;
  try {
    state.me = await api('/api/partner/unlink', { method: 'POST', json: {} });
    state.tab = 'mine';
    await renderApp();
  } catch (ex) { toast(ex.message); }
}

// ---------- Conectare cu partenerul ----------
function viewPair() {
  const err = h('p', { class: 'error', role: 'alert' });
  const input = h('input', { type: 'text', id: 'code', maxlength: '8', placeholder: 'ex: K7M2QX9P', autocapitalize: 'characters', autocomplete: 'off', required: true });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Conectează');

  return h('section', { class: 'pair' },
    h('h2', null, 'Conectează-te cu partenerul'),
    h('p', null, 'Trimite-i codul tău, iar el/ea îl introduce în aplicație (sau invers).'),
    h('div', { class: 'code' }, state.me.inviteCode),
    h('button', {
      class: 'btn small block',
      onclick: async () => {
        try { await navigator.clipboard.writeText(state.me.inviteCode); toast('Cod copiat.'); }
        catch { toast('Selectează codul și copiază-l manual.'); }
      },
    }, 'Copiază codul'),
    h('p', { class: 'divider' }, '— sau —'),
    h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        submit.disabled = true;
        try {
          state.me = await api('/api/partner/link', { method: 'POST', json: { code: input.value } });
          state.tab = 'partner';
          await renderApp();
          toast('Conectat! 💞');
        } catch (ex) {
          err.textContent = ex.message;
          submit.disabled = false;
        }
      },
    },
      h('div', { class: 'field' }, h('label', { for: 'code' }, 'Codul partenerului'), h('div', { class: 'inline' }, input, submit)),
      err,
    ),
  );
}

// ---------- Dialog adăugare / editare ----------
function openItemDialog(item) {
  const editing = !!item;
  let removeImage = false;
  let photoBlob = null; // poza aleasă din telefon/calculator, deja micșorată

  const dlg = h('dialog');
  const err = h('p', { class: 'error', role: 'alert' });
  const status = h('p', { class: 'status' });

  const url = h('input', { type: 'url', id: 'f-url', placeholder: 'https://…', maxlength: '2000', value: item && item.url ? item.url : null });
  const name = h('input', { type: 'text', id: 'f-name', required: true, maxlength: '150', value: item ? item.name : null });
  // type="text" (nu "number"): unele browsere ignoră în tăcere "89,90" în câmpurile numerice; serverul acceptă și virgulă, și punct
  const price = h('input', { type: 'text', id: 'f-price', inputmode: 'decimal', pattern: '[0-9]+([.,][0-9]{1,2})?', title: 'Ex: 450 sau 89,90', maxlength: '12', autocomplete: 'off', value: item && item.price !== null ? item.price : null });
  const priority = h('select', { id: 'f-prio' },
    [1, 2, 3].map((n) => h('option', { value: String(n), selected: (item ? item.priority : 2) === n }, `${hearts(n)}  ${PRIORITY_LABEL[n]}`)));
  const notes = h('textarea', { id: 'f-notes', maxlength: '1000', placeholder: 'mărime, culoare, magazin preferat…' }, item && item.notes ? item.notes : '');
  const file = h('input', { type: 'file', id: 'f-file', accept: 'image/jpeg,image/png,image/webp,image/gif' });
  const imgUrl = h('input', { type: 'url', id: 'f-imgurl', placeholder: 'https://… (link către o poză)', maxlength: '2000' });

  const preview = h('img', { class: 'img-preview', alt: 'Previzualizare poză', hidden: true });
  const removeBtn = h('button', {
    type: 'button', class: 'btn small danger', hidden: true,
    onclick: () => { removeImage = true; photoBlob = null; file.value = ''; imgUrl.value = ''; preview.hidden = true; removeBtn.hidden = true; },
  }, 'Elimină poza');

  function showPreview(src) {
    const safe = src && (src.startsWith('/uploads/') || src.startsWith('blob:') || safeHref(src));
    if (!safe) { preview.hidden = true; return; }
    preview.src = src;
    preview.referrerPolicy = 'no-referrer';
    preview.hidden = false;
  }
  if (item && item.image) { showPreview(item.image); removeBtn.hidden = false; }

  file.addEventListener('change', async () => {
    const chosen = file.files[0];
    if (!chosen) return;
    save.disabled = true;
    status.textContent = 'Pregătesc poza…';
    try {
      photoBlob = await shrinkImage(chosen);
      removeImage = false;
      imgUrl.value = '';
      showPreview(URL.createObjectURL(photoBlob));
      removeBtn.hidden = false;
      status.textContent = '';
    } catch (ex) {
      photoBlob = null;
      file.value = '';
      status.textContent = ex.message;
    } finally {
      save.disabled = false;
    }
  });
  imgUrl.addEventListener('change', () => {
    if (imgUrl.value.trim()) {
      removeImage = false;
      photoBlob = null;
      file.value = '';
      showPreview(imgUrl.value.trim());
      removeBtn.hidden = false;
    }
  });

  const autoBtn = h('button', {
    type: 'button', class: 'btn',
    onclick: async () => {
      if (!url.value.trim()) { status.textContent = 'Lipește mai întâi linkul produsului.'; return; }
      autoBtn.disabled = true;
      status.textContent = 'Caut informații…';
      try {
        const p = await api('/api/preview', { method: 'POST', json: { url: url.value.trim() } });
        let filled = [];
        if (p.name && !name.value.trim()) { name.value = p.name; filled.push('nume'); }
        if (p.price !== null && p.price !== undefined && !price.value) { price.value = p.price; filled.push('preț'); }
        if (p.image) { imgUrl.value = p.image; file.value = ''; photoBlob = null; removeImage = false; showPreview(p.image); removeBtn.hidden = false; filled.push('poză'); }
        status.textContent = filled.length ? `Completat: ${filled.join(', ')}. Verifică și corectează dacă e nevoie.` : 'Pagina nu conține informații utile. Completează manual.';
      } catch (ex) {
        status.textContent = ex.message;
      } finally {
        autoBtn.disabled = false;
      }
    },
  }, 'Completează automat');

  const save = h('button', { class: 'btn primary', type: 'submit' }, editing ? 'Salvează' : 'Adaugă');

  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      save.disabled = true;
      const fd = new FormData();
      fd.set('name', name.value);
      fd.set('url', url.value);
      fd.set('price', price.value);
      fd.set('priority', priority.value);
      fd.set('notes', notes.value);
      if (photoBlob) fd.set('image', photoBlob, 'poza.jpg');
      else if (imgUrl.value.trim()) fd.set('image_url', imgUrl.value.trim());
      else if (removeImage) fd.set('remove_image', '1');
      try {
        await api(editing ? '/api/items/' + item.id : '/api/items', { method: editing ? 'PUT' : 'POST', form: fd });
        dlg.close();
        state.mine = await api('/api/items');
        draw();
        toast(editing ? 'Salvat.' : 'Adăugat în listă. 🎉');
      } catch (ex) {
        err.textContent = ex.message;
        save.disabled = false;
      }
    },
  },
    h('div', { class: 'field' },
      h('label', { for: 'f-url' }, 'Link către produs'),
      h('div', { class: 'inline' }, url, autoBtn),
      status,
    ),
    h('div', { class: 'field' }, h('label', { for: 'f-name' }, 'Ce îți dorești? *'), name),
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', { for: 'f-price' }, 'Preț (lei)'), price),
      h('div', { class: 'field' }, h('label', { for: 'f-prio' }, 'Cât de mult'), priority),
    ),
    h('div', { class: 'field' },
      h('span', { class: 'lbl' }, 'Poză'),
      file,
      imgUrl,
      preview,
      removeBtn,
    ),
    h('div', { class: 'field' }, h('label', { for: 'f-notes' }, 'Notițe'), notes),
    err,
    h('div', { class: 'dlg-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Anulează'),
      save,
    ),
  );

  dlg.append(h('div', { class: 'dlg' }, h('h2', null, editing ? 'Editează cadoul' : 'Adaugă un cadou'), form));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  name.focus();
}

// ---------- Pornire ----------
(async function init() {
  try {
    state.me = await api('/api/me');
  } catch {
    state.me = null;
  }
  state.me ? renderApp() : renderAuth();
})();
