(() => {
  'use strict';
  async function api(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout || 8000);
    try {
      const response = await fetch(url, { cache: 'no-store', ...options, signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data.error || 'The request could not be completed.');
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.status) throw error;
      const failure = new Error('The election server is not responding. Check the connection.');
      failure.uncertain = true;
      throw failure;
    } finally { clearTimeout(timer); }
  }
  const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body) });
  function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  const initials = name => String(name || '').trim().split(/\s+/).filter(Boolean).slice(0,2).map(part => part[0]).join('').toUpperCase();
  function portrait(candidate, className = '') {
    const box = el('span', `portrait ${className}`);
    const fallback = () => box.replaceChildren(el('span', 'portrait-initials', initials(candidate.name)));
    if (candidate.photo) {
      const image = el('img'); image.alt = '';
      image.addEventListener('error', fallback, { once: true });
      image.src = candidate.photo; box.append(image);
    } else fallback();
    return box;
  }
  function makeId() {
    if (globalThis.crypto?.getRandomValues) {
      const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
      return Array.from(bytes, value => value.toString(16).padStart(2,'0')).join('');
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }
  const storage = {
    get(key) { try { return sessionStorage.getItem(key); } catch (_) { return null; } },
    set(key,value) { try { sessionStorage.setItem(key,value); } catch (_) {} },
    remove(key) { try { sessionStorage.removeItem(key); } catch (_) {} }
  };
  async function copy(text) {
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch (_) {}
    const active = document.activeElement;
    const area = el('textarea','sr-only'); area.value = text; area.setAttribute('readonly','');
    document.body.append(area); area.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (_) {}
    area.remove(); active?.focus(); return copied;
  }
  window.Election = Object.freeze({ api, post, el, portrait, initials, makeId, storage, copy });
})();
